const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * SandboxExecutor
 * Performs secure execution of generated commands in a localized environment.
 * Prefers Docker container virtualization, fallbacks to restricted child_process execution.
 */
class SandboxExecutor {
  constructor() {
    this.dockerImage = 'node:18-alpine';
  }

  /**
   * Detects if Docker daemon is running and accessible.
   * @returns {boolean}
   */
  isDockerAvailable() {
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 2000 });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Executes a command within a secure container or restricted shell.
   * @param {string} command - The terminal command to run.
   * @param {Object} [files={}] - Optional virtual files to place in directory: { 'script.js': 'content' }
   * @param {number} [timeoutMs=10000] - Timeout limit in milliseconds.
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
   */
  async execute(command, files = {}, timeoutMs = 15000) {
    const isDocker = this.isDockerAvailable();
    const tempDirName = `sandbox-${crypto.randomBytes(8).toString('hex')}`;
    const tempDirPath = path.join(os.tmpdir(), tempDirName);

    // Create temp workspace and write files
    fs.mkdirSync(tempDirPath, { recursive: true });
    Object.entries(files).forEach(([filename, content]) => {
      fs.writeFileSync(path.join(tempDirPath, filename), content, 'utf8');
    });

    if (isDocker) {
      console.log(`🐳 [SandboxExecutor] Docker detected. Spawning Node.js Virtualization Container...`);
      return this.runDockerSandbox(command, tempDirPath, timeoutMs);
    } else {
      console.log(`🛡️  [SandboxExecutor] Docker unavailable. Falling back to Restricted Process Sandbox...`);
      return this.runRestrictedProcess(command, tempDirPath, timeoutMs);
    }
  }

  /**
   * Runs a command inside a Docker container mounting the temp workspace.
   */
  runDockerSandbox(command, hostDirPath, timeoutMs) {
    return new Promise((resolve) => {
      // Normalize path for Windows docker mount (e.g. C:\... -> /c/...)
      let dockerMountPath = hostDirPath;
      if (process.platform === 'win32') {
        dockerMountPath = hostDirPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, '/$1');
      }

      // docker run --rm -v <host_path>:/workspace -w /workspace node:18-alpine sh -c "cmd"
      const dockerArgs = [
        'run', '--rm',
        '-v', `${dockerMountPath}:/workspace`,
        '-w', '/workspace',
        '--network', 'none', // Disable network access for security
        '--memory', '256m',   // Memory limit
        '--cpus', '0.5',      // CPU limit
        this.dockerImage,
        'sh', '-c', command
      ];

      const child = spawn('docker', dockerArgs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        console.warn(`🛑 [SandboxExecutor] Docker container execution timed out after ${timeoutMs}ms.`);
        resolve({
          stdout,
          stderr: stderr + `\n[SandboxExecutor] ERROR: Timeout of ${timeoutMs}ms exceeded.`,
          exitCode: 124
        });
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        this.cleanupDir(hostDirPath);
        resolve({ stdout, stderr, exitCode: code });
      });
    });
  }

  /**
   * Runs a command in a restricted local child process.
   */
  runRestrictedProcess(command, tempDirPath, timeoutMs) {
    return new Promise((resolve) => {
      // Strip credentials and API tokens from environment variables
      const cleanEnv = {};
      const safeEnvKeys = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'];
      
      Object.keys(process.env).forEach(key => {
        if (safeEnvKeys.includes(key.toUpperCase()) || key.startsWith('NODE_')) {
          cleanEnv[key] = process.env[key];
        }
      });

      // Spawn process in the temp workspace
      const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', 
        [process.platform === 'win32' ? '/c' : '-c', command], {
        cwd: tempDirPath,
        env: cleanEnv,
        uid: process.getuid ? 65534 : undefined, // Run as nobody on UNIX
        gid: process.getgid ? 65534 : undefined
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        console.warn(`🛑 [SandboxExecutor] Restricted process timed out after ${timeoutMs}ms.`);
        resolve({
          stdout,
          stderr: stderr + `\n[SandboxExecutor] ERROR: Timeout of ${timeoutMs}ms exceeded.`,
          exitCode: 124
        });
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        this.cleanupDir(tempDirPath);
        resolve({ stdout, stderr, exitCode: code });
      });
    });
  }

  /**
   * Safely deletes the host temp workspace directory.
   */
  cleanupDir(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`⚠️ [SandboxExecutor] Failed to cleanup temp directory ${dirPath}: ${err.message}`);
    }
  }
}

module.exports = new SandboxExecutor();
