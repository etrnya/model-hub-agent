/**
 * MarkItDownAdapter
 * Bridge adapter to invoke the Python-based MarkItDown tool via CLI.
 * Allows Agent OS to convert PDFs, Excel sheets, HTML pages, and Office documents into clean, token-efficient Markdown.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

class MarkItDownAdapter {
  constructor() {
    // Default path pointing to the installed virtual environment inside the scratch folder
    this.defaultCliPath = path.resolve(
      __dirname,
      '../../../markitdown/.venv/Scripts/markitdown.exe'
    );
  }

  /**
   * Gets the executable path of MarkItDown CLI.
   * Prioritizes process.env.MARKITDOWN_PATH, then defaults to the workspace .venv path.
   * @returns {string}
   */
  getCliPath() {
    const customPath = process.env.MARKITDOWN_PATH;
    if (customPath) {
      return customPath;
    }
    
    // Normalize path to handle Windows backslashes
    return path.normalize(this.defaultCliPath);
  }

  /**
   * Converts a given file to Markdown.
   * @param {string} filePath - Absolute path to the source file.
   * @param {Object} [options] - Additional CLI arguments (e.g., keepDataUris, usePlugins).
   * @returns {Promise<string>} - Resolves with the markdown text.
   */
  async convert(filePath, options = {}) {
    return new Promise((resolve, reject) => {
      // Validate file existence
      const absoluteFilePath = path.resolve(filePath);
      if (!fs.existsSync(absoluteFilePath)) {
        return reject(new Error(`[MarkItDownAdapter] File not found: ${absoluteFilePath}`));
      }

      const cliPath = this.getCliPath();
      const args = [];

      // Append optional configurations
      if (options.keepDataUris) {
        args.push('--keep-data-uris');
      }
      if (options.usePlugins) {
        args.push('--use-plugins');
      }

      // Append target file path
      args.push(absoluteFilePath);

      console.log(`\n📄 [MarkItDownAdapter] Converting file: ${path.basename(filePath)} using ${cliPath}...`);

      execFile(cliPath, args, { 
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      }, (error, stdout, stderr) => {
        if (error) {
          // If the executable wasn't found or returned an error
          console.error(`❌ [MarkItDownAdapter] Conversion failed:`, stderr || error.message);
          return reject(
            new Error(
              `[MarkItDownAdapter] Failed to execute conversion CLI. Please ensure python packages are correctly installed.\nDetails: ${stderr || error.message}`
            )
          );
        }

        console.log(`✅ [MarkItDownAdapter] Successfully converted to Markdown (${stdout.length} characters).`);
        resolve(stdout);
      });
    });
  }
}

module.exports = new MarkItDownAdapter(); // Singleton
