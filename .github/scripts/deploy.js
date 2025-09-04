const Client = require('ssh2-sftp-client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sftp = new Client();

async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function getLocalFiles(dir) {
  let fileList = [];
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.github',
    'package.json',
    'package-lock.json',
    '.gitignore',
    'sftp_deploy_state.json',
    '.DS_Store'
  ];

  function isIgnored(filePath) {
    return ignorePatterns.some(pattern => filePath.includes(pattern));
  }

  function walkSync(currentDirPath, callback) {
    fs.readdirSync(currentDirPath).forEach(function (name) {
      let filePath = path.join(currentDirPath, name);
      let stat = fs.statSync(filePath);

      if (isIgnored(filePath)) {
        return;
      }

      if (stat.isFile()) {
        callback(filePath, stat);
      } else if (stat.isDirectory()) {
        walkSync(filePath, callback);
      }
    });
  }

  walkSync(dir, function (filePath, stat) {
    fileList.push(filePath);
  });

  return fileList;
}

async function getHashes(files) {
  const fileHashes = {};
  await Promise.all(files.map(async (file) => {
    const hash = await calculateFileHash(file);
    fileHashes[file] = hash;
  }));
  return fileHashes;
}

async function createDirectories(directories) {
  const createdDirs = new Set();
  await Promise.all(directories.map(async (dir) => {
    if (!createdDirs.has(dir)) {
      await sftp.mkdir(dir, true);
      createdDirs.add(dir);
    }
  }));
}

function sortDirectoriesByDepth(directories) {
  return directories.sort((a, b) => b.split('/').length - a.split('/').length);
}

async function removeEmptyDirectories(directories) {
  const sortedDirectories = sortDirectoriesByDepth(directories);
  for (let dir of sortedDirectories) {
    try {
      const items = await sftp.list(dir);
      if (items.length === 0) {
        await sftp.rmdir(dir);
        console.log(`Deleted empty directory: ${dir}`);
      }
    } catch (err) {
      if (err.message.includes('replaceAll is not a function')) {
        break;
      } else if (err.code !== 2) {
        console.error(`Failed to process directory ${dir}:`, err);
      }
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deploy() {
  const config = {
    host: process.env.SFTP_HOST,
    port: process.env.SFTP_PORT,
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD,
  };

  const localDir = process.env.SOURCE_DIR;
  const remoteDir = process.env.DESTINATION_DIR;
  const stateFileName = 'sftp_deploy_state.json';
  const remoteStateFilePath = path.join(remoteDir, stateFileName).replace(/\\/g, '/');

  try {
    await sftp.connect(config);

    const localFiles = await getLocalFiles(localDir);
    const localFileHashes = await getHashes(localFiles);

    let remoteFileHashes = {};
    const maxAttempts = 3;
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        await sftp.fastGet(remoteStateFilePath, stateFileName);
        remoteFileHashes = JSON.parse(fs.readFileSync(stateFileName, 'utf8'));
        break;
      } catch (err) {
        attempts++;
        if (attempts < maxAttempts) {
          console.log(`State file not found. Retrying in 5 seconds... (${attempts}/${maxAttempts})`);
          await delay(5000);
        } else {
          console.log('State file still not found after maximum retries. Proceeding as first deployment.');
        }
      }
    }

    const filesToUpload = [];
    const filesToDelete = [];
    const affectedDirs = new Set();

    for (const localFile of localFiles) {
      const relativePath = path.relative(localDir, localFile);
      const remoteFilePath = path.join(remoteDir, relativePath).replace(/\\/g, '/');
      if (localFileHashes[localFile] !== remoteFileHashes[remoteFilePath]) {
        filesToUpload.push({ localFile, remoteFilePath });
        affectedDirs.add(path.dirname(remoteFilePath));
      }
    }

    for (const remoteFilePath in remoteFileHashes) {
      const localFilePath = path.join(localDir, path.relative(remoteDir, remoteFilePath)).replace(/\\/g, '/');
      if (!localFileHashes[localFilePath]) {
        filesToDelete.push(remoteFilePath);
        let dir = path.dirname(remoteFilePath);
        while (dir !== remoteDir && !affectedDirs.has(dir)) {
          affectedDirs.add(dir);
          dir = path.dirname(dir);
        }
      }
    }

    const directories = Array.from(new Set(filesToUpload.map(({ remoteFilePath }) => path.dirname(remoteFilePath))));
    await createDirectories(directories);

    const CONCURRENCY_LIMIT = 5;
    const uploadBatches = [];
    for (let i = 0; i < filesToUpload.length; i += CONCURRENCY_LIMIT) {
      uploadBatches.push(filesToUpload.slice(i, i + CONCURRENCY_LIMIT));
    }

    for (const batch of uploadBatches) {
      await Promise.all(batch.map(async ({ localFile, remoteFilePath }) => {
        await sftp.fastPut(localFile, remoteFilePath);
        console.log(`Uploaded: ${localFile} to ${remoteFilePath}`);
      }));
    }

    for (const { localFile, remoteFilePath } of filesToUpload) {
      remoteFileHashes[remoteFilePath] = localFileHashes[localFile];
    }

    for (const remoteFilePath of filesToDelete) {
      try {
        await sftp.delete(remoteFilePath);
        console.log(`Deleted: ${remoteFilePath}`);
        delete remoteFileHashes[remoteFilePath];
      } catch (err) {
        if (err.code === 2) {
          console.log(`File already deleted: ${remoteFilePath}`);
        } else {
          console.error(`Failed to delete ${remoteFilePath}:`, err);
        }
      }
    }

    await removeEmptyDirectories(Array.from(affectedDirs));

    await sftp.end();

    await sftp.connect(config);

    fs.writeFileSync(stateFileName, JSON.stringify(remoteFileHashes, null, 2), 'utf8');
    await sftp.fastPut(stateFileName, remoteStateFilePath);
    fs.unlinkSync(stateFileName);

    await sftp.end();
  } catch (err) {
    console.error('Error during deployment:', err);
  }
}

deploy();