/**
 * batch_convert.js
 * Batch Document-to-Markdown Conversion Tool.
 * Scans a folder recursively for HTML, PDF, Word, Excel, and PPTX files
 * and batch-converts them to clean Markdown using MarkItDownAdapter.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const markItDownAdapter = require('../infrastructure/adapters/markitdown_adapter');

const SUPPORTED_EXTENSIONS = ['.html', '.pdf', '.docx', '.xlsx', '.pptx'];
const IGNORED_FOLDERS = ['node_modules', '.git', '.venv', 'dist', 'build'];

function getFilesRecursively(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      const folderName = path.basename(filePath);
      if (!IGNORED_FOLDERS.includes(folderName)) {
        getFilesRecursively(filePath, fileList);
      }
    } else {
      const ext = path.extname(filePath).toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

async function runBatchConversion() {
  const args = process.argv.slice(2);
  const inputDir = args[0] ? path.resolve(args[0]) : null;
  const outputDir = args[1] ? path.resolve(args[1]) : null;

  if (!inputDir) {
    console.error("❌ Error: Please specify an input directory.");
    console.log("Usage: npm run batch-convert <input_directory> [output_directory]");
    console.log("Example: npm run batch-convert ./documents ./markdown_outputs");
    process.exit(1);
  }

  if (!fs.existsSync(inputDir)) {
    console.error(`❌ Error: Input directory does not exist: ${inputDir}`);
    process.exit(1);
  }

  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("====================================================");
  console.log("📂 Starting Batch Document Conversion...");
  console.log(`📁 Input Directory: ${inputDir}`);
  console.log(`📁 Output Directory: ${outputDir || "Same as source files"}`);
  console.log("====================================================\n");

  const files = getFilesRecursively(inputDir);
  if (files.length === 0) {
    console.log("🟡 No supported documents found (.html, .pdf, .docx, .xlsx, .pptx).");
    return;
  }

  console.log(`🔍 Found ${files.length} documents to convert.`);

  const results = [];
  let totalOriginalSize = 0;
  let totalMarkdownSize = 0;

  for (const file of files) {
    const filename = path.basename(file);
    const originalSize = fs.statSync(file).size;
    totalOriginalSize += originalSize;

    // Determine target output path
    let targetFile;
    if (outputDir) {
      targetFile = path.join(outputDir, filename + '.md');
    } else {
      targetFile = file + '.md';
    }

    try {
      const markdown = await markItDownAdapter.convert(file);
      fs.writeFileSync(targetFile, markdown, 'utf8');
      
      const markdownSize = Buffer.byteLength(markdown, 'utf8');
      totalMarkdownSize += markdownSize;

      const savingRatio = ((1 - (markdownSize / originalSize)) * 100).toFixed(1);

      results.push({
        File: filename,
        "Original Size": `${(originalSize / 1024).toFixed(1)} KB`,
        "MD Size": `${(markdownSize / 1024).toFixed(1)} KB`,
        "Size Savings": `${savingRatio}%`,
        Status: "🟢 Success"
      });
    } catch (e) {
      results.push({
        File: filename,
        "Original Size": `${(originalSize / 1024).toFixed(1)} KB`,
        "MD Size": "-",
        "Size Savings": "-",
        Status: `❌ Failed: ${e.message.substring(0, 40)}...`
      });
    }
  }

  console.log("\n====================================================");
  console.log("📊 BATCH CONVERSIONS SUMMARY");
  console.log("====================================================");
  console.table(results);
  
  const overallSavings = ((1 - (totalMarkdownSize / totalOriginalSize)) * 100).toFixed(1);
  console.log("\n====================================================");
  console.log(`📈 Overall Size Reduction: ${overallSavings}%`);
  console.log(`📦 Original Total: ${(totalOriginalSize / 1024).toFixed(1)} KB`);
  console.log(`📝 Markdown Total: ${(totalMarkdownSize / 1024).toFixed(1)} KB`);
  console.log("====================================================\n");
}

runBatchConversion();
