#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const https_1 = __importDefault(require("https"));
const fs_1 = __importDefault(require("fs"));
const util_1 = require("util");
// Promisify filesystem methods for cleaner async/await usage
const readFileAsync = (0, util_1.promisify)(fs_1.default.readFile);
const writeFileAsync = (0, util_1.promisify)(fs_1.default.writeFile);
const chmodAsync = (0, util_1.promisify)(fs_1.default.chmod);
const unlinkAsync = (0, util_1.promisify)(fs_1.default.unlink);
// URL for the PHP template
const TEMPLATE_URL = 'https://raw.githubusercontent.com/NavyStack/SynologyCloudFlareDDNS-WithMultiple/master/cloudflare.php';
// Path to the config file
const CONFIG_FILE_PATH = '/etc.defaults/ddns_provider.conf';
// Read and parse the config file
async function readConfigFile(filePath) {
    try {
        return await readFileAsync(filePath, 'utf-8');
    }
    catch (error) {
        if (error instanceof Error) {
            console.error(`Error: Configuration file not found at ${filePath}. ${error.message}`);
        }
        else {
            console.error(`An unknown error occurred while reading the config file: ${JSON.stringify(error)}`);
        }
        process.exit(1);
    }
}
// Write the modified config file
async function writeConfigFile(filePath, data) {
    try {
        await writeFileAsync(filePath, data, 'utf-8');
        console.log('Configuration file updated successfully.');
    }
    catch (error) {
        if (error instanceof Error) {
            console.error(`Error writing to configuration file: ${error.message}`);
        }
        else {
            console.error(`An unknown error occurred while writing to the config file: ${JSON.stringify(error)}`);
        }
    }
}
// Download a file from a URL
async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs_1.default.createWriteStream(dest);
        https_1.default
            .get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download file from ${url} (status code: ${response.statusCode})`));
                return;
            }
            response.pipe(file);
            file.on('finish', async () => {
                try {
                    await chmodAsync(dest, 0o755); // Set permissions to 755
                    console.log(`${dest} downloaded and permissions set successfully.`);
                    resolve();
                }
                catch (chmodError) {
                    if (chmodError instanceof Error) {
                        reject(new Error(`Error setting file permissions: ${chmodError.message}`));
                    }
                    else {
                        reject(new Error(`Unknown error occurred while setting file permissions: ${JSON.stringify(chmodError)}`));
                    }
                }
            });
        })
            .on('error', async (err) => {
            await unlinkAsync(dest).catch(() => { }); // Clean up incomplete download
            if (err instanceof Error) {
                reject(new Error(`Error downloading file: ${err.message}`));
            }
            else {
                reject(new Error(`Unknown error occurred while downloading file: ${JSON.stringify(err)}`));
            }
        });
    });
}
// Remove existing Cloudflare sections and add new ones
function replaceCloudflareSections(data) {
    const lines = data.split('\n');
    const newLines = [];
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
async function generateCloudflareSections() {
    const sections = [];
    for (let i = 1; i <= 10; i++) {
        const sectionNumber = String(i).padStart(2, '0');
        const sectionName = `Cloudflare ${sectionNumber}`;
        const targetFile = `/usr/syno/bin/ddns/cloudflare ${sectionNumber}.php`;
        sections.push(`[${sectionName}]`);
        sections.push(`modulepath=${targetFile}`);
        sections.push('queryurl=https://www.cloudflare.com/');
        // Download the PHP template for each section
        await downloadFile(TEMPLATE_URL, targetFile);
    }
    return sections.join('\n');
}
// Main process
async function main() {
    try {
        const configData = await readConfigFile(CONFIG_FILE_PATH);
        const cleanedConfigData = replaceCloudflareSections(configData);
        const cloudflareSections = await generateCloudflareSections();
        const updatedConfigData = `${cleanedConfigData}\n${cloudflareSections}`;
        await writeConfigFile(CONFIG_FILE_PATH, updatedConfigData);
    }
    catch (error) {
        // Check if error is an instance of Error
        if (error instanceof Error) {
            console.error(`An error occurred: ${error.message}`);
        }
        else {
            console.error(`An unknown error occurred: ${JSON.stringify(error)}`);
        }
    }
}
// Execute the main process
main();
