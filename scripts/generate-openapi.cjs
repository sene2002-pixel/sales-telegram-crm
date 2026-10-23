// Build src/server/http/openapi-document.ts first using npm run build:server.
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { deepStrictEqual } = require('node:assert');
const prettier = require('prettier');
function assertArtifactCurrent(text, expected) {
  let actual;
  try {
    actual = JSON.parse(text);
  } catch {
    throw new Error('OpenAPI artifact is not valid JSON');
  }
  try {
    deepStrictEqual(actual, expected);
  } catch {
    throw new Error('OpenAPI artifact is stale; run node scripts/generate-openapi.cjs');
  }
}
async function exportDocument(openApiDocument, artifact) {
  const text = await prettier.format(JSON.stringify(openApiDocument), {
    ...(await prettier.resolveConfig(artifact)),
    filepath: artifact,
  });
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, text);
}
async function main() {
  const { openApiDocument } = require('../dist/server/http/openapi-document.js');
  const artifact = resolve(__dirname, '../docs/api/openapi.json');
  if (process.argv.includes('--check')) {
    assertArtifactCurrent(readFileSync(artifact, 'utf8'), openApiDocument);
  } else {
    await exportDocument(openApiDocument, artifact);
  }
}
module.exports = { assertArtifactCurrent, exportDocument };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
