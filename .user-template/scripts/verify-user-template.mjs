#!/usr/bin/env node
/**
 * Verifies this user template repository the same way Galascribe verifies any
 * generated publication repository: every Gala document schema-valid,
 * every content file's frontmatter schema-valid and initially publishable,
 * the real `@rathnasgala2/publish-action` admitting those starters in a
 * production publish, and the caller workflow byte-identical to
 * `publish`'s published contract.
 *
 * This file lives under `.user-template/` together with `USER-TEMPLATE.md` because it
 * is workspace-development tooling, not something a person's generated
 * publication repository needs to write an article. Galascribe deletes
 * `.user-template/` in the identity commit it makes right after generating a
 * repository from this user template.
 *
 * The source-only toolchain repositories (`schema`, `template`,
 * `theme-default`, `publish`, and `api`) resolve from `WORKSPACE_ROOT` when
 * set, otherwise from the fixed workspace root relative to this file.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
// .user-template/scripts/ -> .user-template/ -> <repository root> -> v2/
const DEFAULT_RELATIVE_WORKSPACE_ROOT = "../../../";

function resolveWorkspaceRoot() {
  const override = process.env.WORKSPACE_ROOT;
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  return path.resolve(THIS_FILE_DIRECTORY, DEFAULT_RELATIVE_WORKSPACE_ROOT);
}

const workspaceRoot = resolveWorkspaceRoot();
const repositoryDirectory = path.resolve(THIS_FILE_DIRECTORY, "../../");
const schemaRoot = path.join(workspaceRoot, "schema");
const templateRoot = path.join(workspaceRoot, "template");
const defaultThemeRoot = path.join(workspaceRoot, "theme-default");
const publishRoot = path.join(workspaceRoot, "publish");
const publishActionRoot = path.join(publishRoot, "packages", "publish-action");
const publishKernelRoot = path.join(publishRoot, "packages", "publish-kernel");
const adapterProtocolRoot = path.join(
  publishRoot,
  "packages",
  "adapter-protocol",
);
const githubPagesAdapterRoot = path.join(
  publishRoot,
  "packages",
  "adapter-github-pages",
);
const apiTemplateSnapshotRoot = path.join(
  workspaceRoot,
  "api",
  "src",
  "test",
  "resources",
  "imports",
  "user-template",
);

// Publish-action resolves its local schema/template/theme candidates through
// this one workspace boundary. Keep every verifier phase on the same checkout
// instead of mixing the source schema with stale installed packages.
process.env.WORKSPACE_ROOT = workspaceRoot;

/** @type {string[]} */
const failures = [];

function report(label, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** The two pages every site has; `policies` in publication.json names both. */
const POLICY_PAGES = ["terms", "privacy"];

/**
 * The seed rule: a policy seed file is the defaults export's `markdown` member
 * byte for byte, with a single trailing newline appended when the member does
 * not already end in one.
 */
function expectedPolicySeed(markdown) {
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

/**
 * Reads `@rathnasgala2/schemas/site-policy-defaults` from the same schemas
 * checkout the rest of this script uses, through that package's own `exports`
 * map.
 */
async function readSitePolicyDefaults() {
  const packageJson = JSON.parse(
    await readFile(path.join(schemaRoot, "package.json"), "utf8"),
  );
  const entry = packageJson.exports?.["./site-policy-defaults"];
  const target =
    typeof entry === "string" ? entry : (entry?.default ?? entry?.import);
  if (typeof target !== "string") {
    throw new Error(
      `${packageJson.name}@${packageJson.version} has no ./site-policy-defaults export`,
    );
  }
  return JSON.parse(await readFile(path.resolve(schemaRoot, target), "utf8"));
}

async function main() {
  console.log(`workspace root: ${workspaceRoot}`);
  console.log(`repository:     ${repositoryDirectory}`);

  const { validateGalaDocument } = await import(
    pathToFileURL(path.join(schemaRoot, "src", "index.js")).href
  );
  const { ACTIVE_DIGEST_PROFILES } = await import(
    pathToFileURL(
      path.join(schemaRoot, "src", "internal", "digest-profiles.js"),
    ).href
  );

  // 1. Schema-validate every Gala document.
  const documents = [
    ["urn:gala:schema:repository:2.0.0", "gala/repository.json"],
    ["urn:gala:schema:publication:2.0.0", "gala/publication.json"],
    ["urn:gala:schema:navigation:2.0.0", "gala/navigation.json"],
    ["urn:gala:schema:appearance:2.0.0", "gala/appearance.json"],
    [
      "urn:gala:schema:interactions-config:2.0.0",
      "gala/modules/interactions.json",
    ],
    ["urn:gala:schema:lock:2.0.0", "gala.lock.json"],
  ];
  const authorFiles = await readdir(
    path.join(repositoryDirectory, "gala", "authors"),
  );
  for (const name of authorFiles.filter((f) => f.endsWith(".json"))) {
    documents.push(["urn:gala:schema:author:2.0.0", `gala/authors/${name}`]);
  }
  const validatedDocuments = new Map();
  for (const [schemaId, relativePath] of documents) {
    const value = JSON.parse(
      await readFile(path.join(repositoryDirectory, relativePath), "utf8"),
    );
    validatedDocuments.set(relativePath, value);
    const result = validateGalaDocument(schemaId, value);
    report(
      `schema: ${relativePath}`,
      Boolean(result.valid),
      result.valid ? undefined : JSON.stringify(result.diagnostics),
    );
  }

  // The editable Terms and Privacy seeds must equal the schemas package's
  // shipped defaults (App "Reset to default" and the template fallback read the
  // same export), and publication.json must point at exactly those files.
  const policyProblems = [];
  const policySummary = [];
  try {
    const defaults = await readSitePolicyDefaults();
    const policies = validatedDocuments.get("gala/publication.json").policies;
    for (const page of POLICY_PAGES) {
      const shipped = defaults?.[page];
      const named = policies?.[page];
      if (
        typeof shipped?.title !== "string" ||
        typeof shipped?.markdown !== "string"
      ) {
        policyProblems.push(`${page}: no title and markdown in the defaults`);
        continue;
      }
      if (named?.title !== shipped.title) {
        policyProblems.push(
          `${page}: publication.json title ${JSON.stringify(named?.title)} is not ${JSON.stringify(shipped.title)}`,
        );
      }
      const expectedBody = `gala/theme-pages/${page}.md`;
      if (named?.body !== expectedBody) {
        policyProblems.push(
          `${page}: publication.json body ${JSON.stringify(named?.body)} is not ${JSON.stringify(expectedBody)}`,
        );
        continue;
      }
      const seed = await readFile(path.join(repositoryDirectory, expectedBody));
      const expected = Buffer.from(
        expectedPolicySeed(shipped.markdown),
        "utf8",
      );
      if (!seed.equals(expected)) {
        policyProblems.push(
          `${expectedBody}: ${seed.length} bytes, defaults expect ${expected.length}`,
        );
      } else {
        policySummary.push(`${page} ${seed.length} bytes`);
      }
    }
  } catch (error) {
    policyProblems.push(error instanceof Error ? error.message : String(error));
  }
  report(
    "policy seeds equal the schemas defaults",
    policyProblems.length === 0,
    policyProblems.length === 0
      ? policySummary.join(", ")
      : policyProblems.join("; "),
  );

  const lock = JSON.parse(
    await readFile(path.join(repositoryDirectory, "gala.lock.json"), "utf8"),
  );
  report(
    "lock selects the generation-4 Default toolchain",
    lock.repositorySchemaVersion === "3.8.0" &&
      lock.schemas.package === "@rathnasgala2/schemas" &&
      lock.schemas.version === "3.19.0" &&
      lock.schemas.compatibleWith === "^3.0.0" &&
      lock.template.package === "@rathnasgala2/template" &&
      lock.template.version === "4.4.1" &&
      lock.template.contractVersion === "4.1.0" &&
      lock.template.compatibleWith === "^4.0.0" &&
      lock.theme.package === "@rathnasgala2/theme-default" &&
      lock.theme.version === "4.2.0" &&
      lock.theme.contractVersion === "4.1.0" &&
      lock.theme.compatibleWith === "^4.0.0",
    JSON.stringify({
      repositorySchemaVersion: lock.repositorySchemaVersion,
      schemas: lock.schemas,
      template: lock.template,
      theme: lock.theme,
    }),
  );
  report(
    "lock self-excluding digest is current",
    lock.lockDigest === ACTIVE_DIGEST_PROFILES.lock.digest(lock),
    `${lock.lockDigest} vs ${ACTIVE_DIGEST_PROFILES.lock.digest(lock)}`,
  );
  const TOOLCHAIN_OWN = new Set([
    "@rathnasgala2/publish-action",
    "@rathnasgala2/publish-kernel",
    "@rathnasgala2/adapter-protocol",
  ]);
  const NPM_REGISTRY = "https://registry.npmjs.org/";
  const lockRows = [
    lock.resolver,
    lock.schemas,
    lock.template,
    lock.theme,
    ...lock.publisher,
    ...lock.dependencies,
  ];
  const badRows = lockRows.filter((row) => {
    const shaOk =
      typeof row.integrity === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(row.integrity);
    const versionOk = typeof row.version === "string" && row.version !== "";
    if (row.registry === NPM_REGISTRY) return !(shaOk && versionOk);
    return !(TOOLCHAIN_OWN.has(row.package) && shaOk && versionOk);
  });
  report(
    "lock rows follow the registry model",
    badRows.length === 0 &&
      [lock.schemas, lock.template, lock.theme].every(
        (row) => row.registry === NPM_REGISTRY,
      ) &&
      lock.publisher
        .filter((row) => !TOOLCHAIN_OWN.has(row.package))
        .every((row) => row.registry === NPM_REGISTRY),
    JSON.stringify(badRows.map((row) => row.package)),
  );
  const appearance = JSON.parse(
    await readFile(
      path.join(repositoryDirectory, "gala", "appearance.json"),
      "utf8",
    ),
  );
  report(
    "appearance selects Default 4",
    appearance.theme === "@rathnasgala2/theme-default@^4.0.0",
    appearance.theme,
  );
  const selectedAdapters = lock.publisher.filter((entry) =>
    /^@rathnasgala2\/adapter-(?:local-directory|github-pages|do-spaces)$/u.test(
      entry.package,
    ),
  );
  report(
    "lock selects exactly GitHub Pages adapter 0.1.3",
    selectedAdapters.length === 1 &&
      selectedAdapters[0].package === "@rathnasgala2/adapter-github-pages" &&
      selectedAdapters[0].version === "0.1.3",
    JSON.stringify(selectedAdapters),
  );

  // 2. Schema-validate every content file's frontmatter.
  const require = createRequire(
    pathToFileURL(path.join(publishActionRoot, "package.json")).href,
  );
  const YAML = require("yaml");
  const contentFiles = (
    await readdir(path.join(repositoryDirectory, "content"))
  ).filter((f) => f.endsWith(".md"));
  const starterFrontmatter = [];
  // The About page lives in gala/theme-pages/, not content/: content/ is the
  // author's own posts and pages.
  const ABOUT_PATH = "gala/theme-pages/about.md";
  const aboutText = await readFile(
    path.join(repositoryDirectory, ABOUT_PATH),
    "utf8",
  ).catch(() => null);
  const aboutFrontmatter =
    aboutText === null
      ? undefined
      : YAML.parse(aboutText.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "");
  const contentAboutPresent = await stat(
    path.join(repositoryDirectory, "content", "about.md"),
  ).then(
    () => true,
    () => false,
  );
  report(
    "About page is gala/theme-pages/about.md (kind page, slug about), not content/about.md",
    aboutFrontmatter?.kind === "page" &&
      aboutFrontmatter?.slug === "about" &&
      !contentAboutPresent,
    `kind=${String(aboutFrontmatter?.kind)} slug=${String(aboutFrontmatter?.slug)} content/about.md present=${contentAboutPresent}`,
  );
  const starterFiles = [
    ...contentFiles.map((name) => ({
      label: `content/${name}`,
      rel: `content/${name}`,
      name,
    })),
    { label: ABOUT_PATH, rel: ABOUT_PATH, name: "about.md" },
  ].filter((f) => f.rel !== ABOUT_PATH || aboutText !== null);
  for (const { label, rel, name } of starterFiles) {
    const text = await readFile(path.join(repositoryDirectory, rel), "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) {
      report(`frontmatter: ${label}`, false, "no frontmatter fence found");
      continue;
    }
    const frontmatter = YAML.parse(match[1]);
    starterFrontmatter.push({ name, frontmatter });
    const result = validateGalaDocument(
      "urn:gala:schema:content-frontmatter:2.0.0",
      frontmatter,
    );
    report(
      `frontmatter: ${label}`,
      Boolean(result.valid),
      result.valid ? undefined : JSON.stringify(result.diagnostics),
    );
    report(
      `starter state: ${label}`,
      frontmatter.status === "published" &&
        typeof frontmatter.publishedAt === "string",
      `status=${String(frontmatter.status)} publishedAt=${String(frontmatter.publishedAt)}`,
    );
  }

  const publication = validatedDocuments.get("gala/publication.json");
  const navigation = validatedDocuments.get("gala/navigation.json");
  const starterAuthor = validatedDocuments.get(
    "gala/authors/placeholder-author.json",
  );
  const starterArticle = starterFrontmatter.find(
    ({ frontmatter }) => frontmatter.kind === "article",
  )?.frontmatter;
  report(
    "starter content exercises Default Home, Article, and Author layouts",
    navigation.items.some(
      (item) => item.type === "internal" && item.route === "/",
    ) &&
      typeof starterArticle?.description === "string" &&
      starterArticle.description.length > 0 &&
      starterArticle.tags.length > 0 &&
      typeof starterArticle.series === "string" &&
      publication.authors.includes("gala/authors/placeholder-author.json") &&
      starterArticle.authors.includes(starterAuthor.id),
    JSON.stringify({
      homeRoute: navigation.items.find((item) => item.route === "/")?.route,
      article: starterArticle?.slug,
      author: starterAuthor.id,
    }),
  );

  // 3. Publish normalization must admit every starter. A generated repository
  // that contains only these files must be publishable without a hidden
  // visibility edit first.
  const { buildBuildInputFromRepository } = await import(
    pathToFileURL(
      path.join(publishActionRoot, "src", "normalize", "repository-intake.js"),
    ).href
  );
  const publishInput = await buildBuildInputFromRepository({
    repositoryDirectory,
    includeDraftsAsUnlisted: false,
  });
  const publishContent = /** @type {{frontmatter?: {status?: string}}[]} */ (
    publishInput.content
  );
  report(
    "publish-action includes every published starter in a production publish",
    publishContent.length === starterFiles.length &&
      publishContent.every((item) => item.frontmatter?.status === "published"),
    JSON.stringify(publishContent.map((item) => item.frontmatter?.status)),
  );

  // 4. The caller workflow must be byte-identical to publish's own contract.
  const callerPath = path.join(
    repositoryDirectory,
    ".github",
    "workflows",
    "gala-publish-v2.yml",
  );
  // GALA_DOCS_CALLER_PATH lets CI compare against publish main's copy: the
  // pinned toolchain commit predates the docs update that names it.
  const contractPath =
    process.env.GALA_DOCS_CALLER_PATH ||
    path.join(publishRoot, "docs", "callers", "gala-publish-v2.yml");
  const [callerBytes, contractBytes] = await Promise.all([
    readFile(callerPath),
    readFile(contractPath),
  ]);
  const digest = (buf) => createHash("sha256").update(buf).digest("hex");
  report(
    "caller workflow byte-identical to publish/docs/callers/gala-publish-v2.yml",
    digest(callerBytes) === digest(contractBytes),
    `${digest(callerBytes)} vs ${digest(contractBytes)}`,
  );
  const callerPin = callerBytes
    .toString("utf8")
    .match(
      /rathnasgala2\/publish\/\.github\/workflows\/publish-v2\.yml@([0-9a-f]{40})/,
    )?.[1];
  const templateGuide = await readFile(
    path.join(repositoryDirectory, ".user-template", "USER-TEMPLATE.md"),
    "utf8",
  );
  const callerRef = callerBytes
    .toString("utf8")
    .match(/publish_toolchain_ref:\s*([0-9a-f]{40})/u)?.[1];
  report(
    "USER-TEMPLATE.md documents the caller workflow pin",
    callerPin !== undefined &&
      callerPin === callerRef &&
      templateGuide.includes(`\`${callerPin}\``),
    `uses=${callerPin} ref=${callerRef}`,
  );

  const snapshotPaths = [
    ".github/workflows/gala-publish-v2.yml",
    "gala.lock.json",
    "gala/appearance.json",
    "gala/authors/placeholder-author.json",
    "gala/modules/interactions.json",
    "gala/navigation.json",
    "gala/publication.json",
    "gala/repository.json",
    "gala/theme-pages/about.md",
    "gala/theme-pages/privacy.md",
    "gala/theme-pages/terms.md",
  ];
  const snapshotMismatches = [];
  for (const relativePath of snapshotPaths) {
    const templateBytes = await readFile(
      path.join(repositoryDirectory, relativePath),
    );
    const snapshotBytes = await readFile(
      path.join(apiTemplateSnapshotRoot, relativePath),
    ).catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (snapshotBytes === null) {
      snapshotMismatches.push(`${relativePath} (missing in the fixture)`);
    } else if (!templateBytes.equals(snapshotBytes)) {
      snapshotMismatches.push(relativePath);
    }
  }
  const apiSiblingPresent = await stat(path.join(workspaceRoot, "api")).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  if (apiSiblingPresent) {
    report(
      "API current-template import fixture is byte-identical",
      snapshotMismatches.length === 0,
      snapshotMismatches.join(", "),
    );
  } else {
    // The api repository is private; public CI has no checkout of it.
    console.log(
      "[SKIP] API current-template import fixture is byte-identical — api sibling not present",
    );
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("All checks passed.");
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
