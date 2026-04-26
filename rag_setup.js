// rag_setup.js
//
// Usage (PowerShell):
//   cd C:\Users\jmatu\slack-context-bot
//   node rag_setup.js "C:\Users\jmatu\Documents\F3\Simple Context Bot RAG"
//
// What it does:
// 1) Finds all .md files under the docs folder
// 2) Uploads them to OpenAI (purpose: "assistants")
// 3) Creates a vector store
// 4) Adds all uploaded files to the vector store as a batch
// 5) Polls batch status with progress + timeout
// 6) Prints VECTOR_STORE_ID (prints immediately after vector store creation, too)

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx", ".html", ".csv", ".json"]);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

function walkDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeBatchDebug(batch) {
  // Different SDK versions may return different shapes; keep logs resilient
  return {
    id: batch?.id,
    batch_id: batch?.batch_id,
    status: batch?.status,
    file_counts: batch?.file_counts,
    // include any other likely identifiers if present
    vector_store_id: batch?.vector_store_id,
  };
}

async function main() {
  const docsDir = process.argv[2];
  if (!docsDir) {
    console.error(
      'Missing docs folder path.\nExample: node rag_setup.js "C:\\Users\\jmatu\\Documents\\F3\\Simple Context Bot RAG"'
    );
    process.exit(1);
  }
  if (!fs.existsSync(docsDir)) {
    console.error("Folder not found:", docsDir);
    process.exit(1);
  }

  const allFiles = walkDir(docsDir).filter((f) =>
    SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase())
  );
  if (allFiles.length === 0) {
    console.error(
      `No supported files found under: ${docsDir}\nSupported extensions: ${[
        ...SUPPORTED_EXTENSIONS,
      ].join(", ")}`
    );
    process.exit(1);
  }

  console.log(`Found ${allFiles.length} supported files. Uploading...`);

  const uploadedFileIds = [];
  for (const filePath of allFiles) {
    process.stdout.write(`Uploading: ${filePath} ... `);
    const up = await openai.files.create({
      file: fs.createReadStream(filePath),
      purpose: "assistants",
    });
    uploadedFileIds.push(up.id);
    console.log("OK");
  }

  console.log("Creating vector store...");
  const vs = await openai.vectorStores.create({
    name: `Simple Context Bot - F3 Nation Docs (${new Date().toISOString().slice(0, 10)})`,
  });

  // Print immediately so you keep the ID even if indexing fails later
  console.log(`\nVECTOR_STORE_ID=${vs.id}\n`);

  console.log("Adding files to vector store (batch)...");
  const batch = await openai.vectorStores.fileBatches.create(vs.id, {
    file_ids: uploadedFileIds,
  });

  // Log shape/ids so we can debug across SDK versions
  console.log("Batch create response keys:", Object.keys(batch || {}));
  console.log("Batch create response (safe):", safeBatchDebug(batch));

  // Robustly determine the batch id
  const batchId = batch?.id || batch?.batch_id;
  if (!batchId) {
    throw new Error("Could not determine batch id from create() response.");
  }

  // Poll with progress + timeout
  const started = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  let current = batch;

  while (current.status === "queued" || current.status === "in_progress") {
    const counts = current.file_counts || {};
    process.stdout.write(
      `Status: ${current.status} | processed=${counts.processed ?? "?"} ` +
        `completed=${counts.completed ?? "?"} failed=${counts.failed ?? "?"}\r`
    );

    if (Date.now() - started > TIMEOUT_MS) {
      console.log("\nTimed out waiting for indexing to complete.");
      console.log(`VECTOR_STORE_ID=${vs.id}`);
      console.log(`BATCH_ID=${batchId}`);
      process.exit(1);
    }

    await sleep(2000);
    current = await openai.vectorStores.fileBatches.retrieve(batchId, { vector_store_id: vs.id });
  }

  console.log("\nBatch status:", current.status);

  if (current.status !== "completed") {
    console.error("Batch did not complete successfully.");
    console.log("Final batch (safe):", safeBatchDebug(current));
    process.exit(1);
  }

  console.log("\n✅ Vector store ready.");
  console.log(`VECTOR_STORE_ID=${vs.id}`);
}

main().catch((e) => {
  console.error("\nError:", e);
  process.exit(1);
});
