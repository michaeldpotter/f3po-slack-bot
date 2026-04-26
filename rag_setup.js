// rag_setup.js
//
// Usage:
//   node rag_setup.js rebuild [docsDir]
//   node rag_setup.js add [docsDir]
//
// Defaults:
//   mode: rebuild
//   docsDir: VECTOR_STORE_SOURCE_DIR or ./VectorStore
//
// Modes:
//   rebuild - creates a new vector store, uploads all docs, and updates VECTOR_STORE_ID in .env
//   add     - uploads only new/changed docs into the existing VECTOR_STORE_ID

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx", ".html", ".csv", ".json"]);
const DEFAULT_DOCS_DIR = process.env.VECTOR_STORE_SOURCE_DIR || "VectorStore";
const DEFAULT_ENV_PATH = ".env";
const VECTOR_STORE_NAME_PREFIX = "F3PO Knowledge Docs";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

function printUsage() {
  console.log(`
Usage:
  node rag_setup.js rebuild [docsDir]
  node rag_setup.js add [docsDir]

Examples:
  node rag_setup.js rebuild
  node rag_setup.js rebuild ./VectorStore
  node rag_setup.js add ./VectorStore

Notes:
  - rebuild creates a new vector store and writes its ID to .env.
  - add uses the current VECTOR_STORE_ID and uploads only new or changed files.
  - docsDir defaults to VECTOR_STORE_SOURCE_DIR or ./VectorStore.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const first = args[0];

  if (first === "--help" || first === "-h") {
    return { help: true };
  }

  if (first === "rebuild" || first === "add") {
    return {
      mode: first,
      docsDir: args[1] || DEFAULT_DOCS_DIR,
    };
  }

  // Backward compatible: node rag_setup.js ./docs
  return {
    mode: "rebuild",
    docsDir: first || DEFAULT_DOCS_DIR,
  };
}

function walkDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function getSourceFiles(docsDir) {
  if (!fs.existsSync(docsDir)) {
    throw new Error(`Folder not found: ${docsDir}`);
  }

  const absoluteDocsDir = path.resolve(docsDir);
  const allFiles = walkDir(absoluteDocsDir)
    .filter((f) => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((absolutePath) => {
      const sourcePath = path.relative(absoluteDocsDir, absolutePath).split(path.sep).join("/");
      return {
        absolutePath,
        sourcePath,
        name: path.basename(absolutePath),
        extension: path.extname(absolutePath).toLowerCase(),
        hash: fileHash(absolutePath),
      };
    });

  if (allFiles.length === 0) {
    throw new Error(
      `No supported files found under: ${docsDir}\nSupported extensions: ${[
        ...SUPPORTED_EXTENSIONS,
      ].join(", ")}`
    );
  }

  return allFiles;
}

function sourceAttributes(file) {
  return {
    source_path: file.sourcePath,
    source_name: file.name,
    source_hash: file.hash,
    source_ext: file.extension,
    source: "f3po-vectorstore",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeBatchDebug(batch) {
  return {
    id: batch?.id,
    batch_id: batch?.batch_id,
    status: batch?.status,
    file_counts: batch?.file_counts,
    vector_store_id: batch?.vector_store_id,
  };
}

async function pollBatch(vectorStoreId, batch) {
  const batchId = batch?.id || batch?.batch_id;
  if (!batchId) {
    throw new Error("Could not determine batch id from create() response.");
  }

  const started = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  let current = batch;

  while (current.status === "queued" || current.status === "in_progress") {
    const counts = current.file_counts || {};
    process.stdout.write(
      `Status: ${current.status} | processed=${counts.processed ?? "?"} ` +
        `completed=${counts.completed ?? "?"} failed=${counts.failed ?? "?"}\r`
    );

    if (Date.now() - started > timeoutMs) {
      console.log("\nTimed out waiting for indexing to complete.");
      console.log(`VECTOR_STORE_ID=${vectorStoreId}`);
      console.log(`BATCH_ID=${batchId}`);
      process.exit(1);
    }

    await sleep(2000);
    current = await openai.vectorStores.fileBatches.retrieve(batchId, {
      vector_store_id: vectorStoreId,
    });
  }

  console.log("\nBatch status:", current.status);

  if (current.status !== "completed") {
    console.error("Batch did not complete successfully.");
    console.log("Final batch (safe):", safeBatchDebug(current));
    process.exit(1);
  }
}

async function uploadFiles(files) {
  const uploaded = [];

  for (const file of files) {
    process.stdout.write(`Uploading: ${file.sourcePath} ... `);
    const up = await openai.files.create({
      file: fs.createReadStream(file.absolutePath),
      purpose: "assistants",
    });
    uploaded.push({ file, fileId: up.id });
    console.log("OK");
  }

  return uploaded;
}

async function attachFiles(vectorStoreId, uploaded) {
  if (uploaded.length === 0) {
    console.log("No files to attach.");
    return;
  }

  console.log("Adding files to vector store (batch)...");
  const batch = await openai.vectorStores.fileBatches.create(vectorStoreId, {
    files: uploaded.map(({ file, fileId }) => ({
      file_id: fileId,
      attributes: sourceAttributes(file),
    })),
  });

  console.log("Batch create response keys:", Object.keys(batch || {}));
  console.log("Batch create response (safe):", safeBatchDebug(batch));

  await pollBatch(vectorStoreId, batch);
}

async function listVectorStoreFiles(vectorStoreId) {
  const files = [];
  const page = await openai.vectorStores.files.list(vectorStoreId, { limit: 100 });

  for await (const file of page.iterPages()) {
    files.push(...file.getPaginatedItems());
  }

  return files;
}

async function removeVectorStoreFile(vectorStoreId, fileId) {
  await openai.vectorStores.files.delete(fileId, { vector_store_id: vectorStoreId });
}

function updateEnvFile(vectorStoreId, envPath = DEFAULT_ENV_PATH) {
  const resolvedEnvPath = path.resolve(envPath);
  const line = `VECTOR_STORE_ID=${vectorStoreId}`;

  let contents = "";
  if (fs.existsSync(resolvedEnvPath)) {
    contents = fs.readFileSync(resolvedEnvPath, "utf8");
  }

  if (/^VECTOR_STORE_ID=.*$/m.test(contents)) {
    contents = contents.replace(/^VECTOR_STORE_ID=.*$/m, line);
  } else {
    const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    contents = `${contents}${prefix}${line}\n`;
  }

  fs.writeFileSync(resolvedEnvPath, contents);
  console.log(`Updated ${path.relative(process.cwd(), resolvedEnvPath) || envPath} with VECTOR_STORE_ID.`);
}

async function rebuild(files) {
  console.log("Creating vector store...");
  const vs = await openai.vectorStores.create({
    name: `${VECTOR_STORE_NAME_PREFIX} (${new Date().toISOString().slice(0, 10)})`,
  });

  console.log(`\nVECTOR_STORE_ID=${vs.id}\n`);

  const uploaded = await uploadFiles(files);
  await attachFiles(vs.id, uploaded);
  updateEnvFile(vs.id);

  console.log("\nVector store rebuilt and ready.");
  console.log(`VECTOR_STORE_ID=${vs.id}`);
}

async function add(files) {
  const vectorStoreId = requireEnv("VECTOR_STORE_ID");
  console.log(`Using existing vector store: ${vectorStoreId}`);

  const remoteFiles = await listVectorStoreFiles(vectorStoreId);
  const remoteByPath = new Map();
  for (const remoteFile of remoteFiles) {
    const sourcePath = remoteFile.attributes?.source_path;
    if (!sourcePath) continue;
    if (!remoteByPath.has(sourcePath)) remoteByPath.set(sourcePath, []);
    remoteByPath.get(sourcePath).push(remoteFile);
  }

  const filesToUpload = [];
  let skipped = 0;
  let replaced = 0;

  for (const file of files) {
    const existing = remoteByPath.get(file.sourcePath) || [];
    const unchanged = existing.some((remoteFile) => remoteFile.attributes?.source_hash === file.hash);

    if (unchanged) {
      for (const remoteFile of existing) {
        if (remoteFile.attributes?.source_hash === file.hash) continue;
        process.stdout.write(`Removing stale vector entry: ${file.sourcePath} (${remoteFile.id}) ... `);
        await removeVectorStoreFile(vectorStoreId, remoteFile.id);
        replaced += 1;
        console.log("OK");
      }
      skipped += 1;
      continue;
    }

    for (const remoteFile of existing) {
      process.stdout.write(`Removing old vector entry: ${file.sourcePath} (${remoteFile.id}) ... `);
      await removeVectorStoreFile(vectorStoreId, remoteFile.id);
      replaced += 1;
      console.log("OK");
    }

    filesToUpload.push(file);
  }

  console.log(`Skipped unchanged files: ${skipped}`);
  console.log(`Removed old vector entries: ${replaced}`);

  const uploaded = await uploadFiles(filesToUpload);
  await attachFiles(vectorStoreId, uploaded);

  console.log("\nVector store updated.");
  console.log(`VECTOR_STORE_ID=${vectorStoreId}`);
}

async function main() {
  const { help, mode, docsDir } = parseArgs(process.argv);

  if (help) {
    printUsage();
    return;
  }

  const files = getSourceFiles(docsDir);
  console.log(`Mode: ${mode}`);
  console.log(`Docs folder: ${docsDir}`);
  console.log(`Found ${files.length} supported files.`);

  if (mode === "rebuild") {
    await rebuild(files);
    return;
  }

  if (mode === "add") {
    await add(files);
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

main().catch((e) => {
  console.error("\nError:", e.message || e);
  process.exit(1);
});
