#!/usr/bin/env node

import https from 'https';
import fs from 'fs';
import { promisify } from 'util';

// Promisify filesystem methods for cleaner async/await usage
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const chmodAsync = promisify(fs.chmod);
const unlinkAsync = promisify(fs.unlink);

const TEMPLATE_URL =
  'https://raw.githubusercontent.com/NavyStack/SynologyCloudFlareDDNS-WithMultiple/master/dist/template.js';

// Path to the config file
const CONFIG_FILE_PATH = '/etc.defaults/ddns_provider.conf';

// Read and parse the config file
async function readConfigFile(filePath: string): Promise<string> {
  try {
    return await readFileAsync(filePath, 'utf-8');
  } catch (error) {
    if (error instanceof Error) {
      console.error(
        `Error: Configuration file not found at ${filePath}. ${error.message}`
      );
    } else {
      console.error(
        `An unknown error occurred while reading the config file: ${JSON.stringify(
          error
        )}`
      );
    }
    process.exit(1);
  }
}

// Write the modified config file
async function writeConfigFile(filePath: string, data: string): Promise<void> {
  try {
    await writeFileAsync(filePath, data, 'utf-8');
    console.log('Configuration file updated successfully.');
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error writing to configuration file: ${error.message}`);
    } else {
      console.error(
        `An unknown error occurred while writing to the config file: ${JSON.stringify(
          error
        )}`
      );
    }
  }
}

// Download a file from a URL
async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(
            new Error(
              `Failed to download file from ${url} (status code: ${response.statusCode})`
            )
          );
          return;
        }

        response.pipe(file);
        file.on('finish', async () => {
          try {
            await chmodAsync(dest, 0o755); // Set permissions to 755
            console.log(`${dest} downloaded and permissions set successfully.`);
            resolve();
          } catch (chmodError) {
            if (chmodError instanceof Error) {
              reject(
                new Error(
                  `Error setting file permissions: ${chmodError.message}`
                )
              );
            } else {
              reject(
                new Error(
                  `Unknown error occurred while setting file permissions: ${JSON.stringify(
                    chmodError
                  )}`
                )
              );
            }
          }
        });
      })
      .on('error', async (err) => {
        await unlinkAsync(dest).catch(() => {}); // Clean up incomplete download
        if (err instanceof Error) {
          reject(new Error(`Error downloading file: ${err.message}`));
        } else {
          reject(
            new Error(
              `Unknown error occurred while downloading file: ${JSON.stringify(
                err
              )}`
            )
          );
        }
      });
  });
}

// Remove existing Cloudflare sections and add new ones
function replaceCloudflareSections(data: string): string {
  const lines = data.split('\n');
  const newLines: string[] = [];
  let inCloudflareSection = false;

  for (const line of lines) {
    if (line.trim().startsWith('[Cloudflare')) {
      inCloudflareSection = true;
      continue;
    }
    if (inCloudflareSection && line.trim().startsWith('[')) {
      inCloudflareSection = false;
    }
    if (!inCloudflareSection) {
      newLines.push(line);
    }
  }

  return newLines.join('\n');
}

// Generate the new Cloudflare sections
async function generateCloudflareSections(): Promise<string> {
  const sections: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const sectionNumber = String(i).padStart(2, '0');
    const sectionName = `Cloudflare ${sectionNumber}`;
    const targetFile = `/usr/syno/bin/ddns/cloudflare${sectionNumber}.js`;

    sections.push(`[${sectionName}]`);
    sections.push(`modulepath=${targetFile}`);
    sections.push('queryurl=https://www.cloudflare.com/');
    await downloadFile(TEMPLATE_URL, targetFile);
  }

  return sections.join('\n');
}

// Main process
async function main(): Promise<void> {
  try {
    const configData = await readConfigFile(CONFIG_FILE_PATH);
    const cleanedConfigData = replaceCloudflareSections(configData);
    const cloudflareSections = await generateCloudflareSections();
    const updatedConfigData = `${cleanedConfigData}\n${cloudflareSections}`;

    await writeConfigFile(CONFIG_FILE_PATH, updatedConfigData);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`An error occurred: ${error.message}`);
    } else {
      console.error(`An unknown error occurred: ${JSON.stringify(error)}`);
    }
  }
}

main();
