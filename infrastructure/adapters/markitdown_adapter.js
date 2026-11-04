/**
 * MarkItDownAdapter
 * Bridge adapter to invoke the Python-based MarkItDown tool via CLI.
 * Allows Agent OS to convert PDFs, Excel sheets, HTML pages, and Office documents into clean, token-efficient Markdown.
 * Features: MD5-based Transcoding Cache to save 100% time and tokens for previously converted files.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class MarkItDownAdapter {
  constructor() {
    // Default path pointing to the installed virtual environment inside the scratch folder
    this.defaultCliPath = path.resolve(
      __dirname,
      '../../../markitdown/.venv/Scripts/markitdown.exe'
    );
    this.cacheDir = path.resolve(__dirname, '../../.cache');
    this.cacheFile = path.join(this.cacheDir, 'markitdown_cache.json');
  }

  /**
   * Calculates the MD5 hash of a file.
   * @param {string} filePath 
   * @returns {string}
   */
  getFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('md5');
    hash.update(fileBuffer);
    return hash.digest('hex');
  }

  /**
   * Loads the cache from disk.
   * @returns {Object}
   */
  loadCache() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      if (fs.existsSync(this.cacheFile)) {
        return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      }
    } catch (err) {
      console.warn(`[MarkItDownAdapter] Failed to load cache:`, err.message);
    }
    return {};
  }

  /**
   * Saves the cache to disk.
   * @param {Object} cache 
   */
  saveCache(cache) {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      fs.writeFileSync(this.cacheFile, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[MarkItDownAdapter] Failed to save cache:`, err.message);
    }
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

      // Check Cache First
      let fileHash;
      try {
        fileHash = this.getFileHash(absoluteFilePath);
        const cache = this.loadCache();
        if (cache[fileHash]) {
          console.log(`\n✨ [MarkItDownAdapter] Cache HIT for file: ${path.basename(filePath)} (MD5: ${fileHash}). Saved 100% processing time.`);
          return resolve(cache[fileHash].markdown);
        }
      } catch (err) {
        console.warn(`[MarkItDownAdapter] Hash/Cache lookup failed, proceeding with direct conversion.`, err.message);
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

      console.log(`\n📄 [MarkItDownAdapter] Cache MISS. Converting file: ${path.basename(filePath)} using ${cliPath}...`);

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

        // Save result to cache
        try {
          if (fileHash) {
            const cache = this.loadCache();
            cache[fileHash] = {
              markdown: stdout,
              timestamp: new Date().toISOString(),
              fileName: path.basename(filePath)
            };
            this.saveCache(cache);
          }
        } catch (err) {
          console.warn(`[MarkItDownAdapter] Failed to write conversion cache:`, err.message);
        }

        resolve(stdout);
      });
    });
  }
}

module.exports = new MarkItDownAdapter(); // Singleton
