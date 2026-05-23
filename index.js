const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Root directory for logs and summary
const ROOT_DIR = __dirname;

// FlareSolverr configuration
const FLARESOLVERR_URL = 'http://localhost:8191/v1';
let USE_FLARESOLVERR = true;

// Global error log array
let globalErrorLog = [];
let globalSummary = {
    startTime: null,
    endTime: null,
    totalPages: 0,
    processedPages: 0,
    totalMoviesFound: 0,
    totalSuccessfulDownloads: 0,
    totalFailedDownloads: 0,
    pages: []
};

// Test FlareSolverr connection
async function testFlareSolverr() {
    try {
        const response = await axios.get('http://localhost:8191/v1', { timeout: 5000 });
        console.log('✅ FlareSolverr is connected');
        return true;
    } catch (error) {
        console.log('❌ FlareSolverr is NOT running. Will use direct requests.');
        return false;
    }
}

// Helper function to fetch with or without FlareSolverr
async function fetchWithFallback(url, retries = 3) {
    // First try without FlareSolverr (direct)
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`  Direct attempt ${i + 1}/${retries} for ${url.substring(0, 50)}...`);
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                timeout: 30000,
                maxRedirects: 5
            });
            
            if (response.data && (typeof response.data === 'string' || response.data.length > 0)) {
                console.log(`  ✅ Direct request successful`);
                return response.data;
            }
        } catch (error) {
            console.log(`  Direct attempt ${i + 1} failed: ${error.message}`);
            if (i === retries - 1 && USE_FLARESOLVERR) {
                // If direct fails, try FlareSolverr
                console.log(`  Trying FlareSolverr as fallback...`);
                try {
                    const flareResponse = await axios.post(FLARESOLVERR_URL, {
                        cmd: 'request.get',
                        url: url,
                        maxTimeout: 60000,
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    });
                    
                    if (flareResponse.data.status === 'ok') {
                        console.log(`  ✅ FlareSolverr request successful`);
                        return flareResponse.data.solution.response;
                    }
                } catch (flareError) {
                    console.log(`  FlareSolverr also failed: ${flareError.message}`);
                }
            }
            // await sleep(2000);
        }
    }
    throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

// Function to save global error log
async function saveGlobalErrorLog() {
    if (globalErrorLog.length > 0) {
        const errorLogPath = path.join(ROOT_DIR, 'error_log.json');
        const errorLogData = {
            timestamp: new Date().toISOString(),
            total_errors: globalErrorLog.length,
            errors: globalErrorLog
        };
        await fs.writeJson(errorLogPath, errorLogData, { spaces: 2 });
        console.log(`📝 Global error log saved to: ${errorLogPath}`);
    }
}

// Function to save global summary
async function saveGlobalSummary() {
    const summaryPath = path.join(ROOT_DIR, 'summary.json');
    globalSummary.endTime = new Date().toISOString();
    globalSummary.duration_seconds = globalSummary.startTime ? 
        (new Date(globalSummary.endTime) - new Date(globalSummary.startTime)) / 1000 : 0;
    
    await fs.writeJson(summaryPath, globalSummary, { spaces: 2 });
    console.log(`📊 Global summary saved to: ${summaryPath}`);
}

// Function to add error to log
function addErrorToLog(errorType, page, movieId, errorMessage, url = null) {
    const errorEntry = {
        timestamp: new Date().toISOString(),
        type: errorType,
        page: page,
        movieId: movieId,
        error: errorMessage,
        url: url
    };
    globalErrorLog.push(errorEntry);
    
    // Also save to individual page error file
    const pageFolder = path.join(__dirname, 'pages', String(page));
    const pageErrorPath = path.join(pageFolder, 'page_errors.json');
    savePageError(pageErrorPath, errorEntry);
}

// Function to save page-specific errors
async function savePageError(pageErrorPath, errorEntry) {
    try {
        let existingErrors = [];
        if (await fs.pathExists(pageErrorPath)) {
            existingErrors = await fs.readJson(pageErrorPath);
        }
        existingErrors.push(errorEntry);
        await fs.writeJson(pageErrorPath, existingErrors, { spaces: 2 });
    } catch (err) {
        console.error(`Failed to save page error: ${err.message}`);
    }
}

// Alternative: Try to find working sitemap URLs
async function findWorkingSitemapUrl(page) {
    const possibleUrls = [
        `https://missav.ws/sitemap_actresses_${page}.xml`,
        `https://missav.live/sitemap_actresses_${page}.xml`,
        `https://missav.ai/sitemap_actresses_${page}.xml`
    ];
    
    for (const url of possibleUrls) {
        try {
            console.log(`  Trying: ${url}`);
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/xml,text/xml,*/*'
                },
                timeout: 10000,
                validateStatus: function (status) {
                    return status === 200; // Only accept 200
                }
            });
            
            if (response.data && response.data.includes('<urlset')) {
                console.log(`  ✅ Found working URL: ${url}`);
                return { url, data: response.data };
            }
        } catch (error) {
            // Continue to next URL
        }
    }
    return null;
}

// Main function to process all pages
async function processAllPages(startPage = 1, endPage = 100) {
    globalSummary.startTime = new Date().toISOString();
    globalSummary.totalPages = endPage - startPage + 1;
    
    console.log(`\n🚀 Starting automatic download for pages ${startPage} to ${endPage}...`);
    console.log(`📝 Error log will be saved to: ${path.join(ROOT_DIR, 'error_log.json')}`);
    console.log(`📊 Summary will be saved to: ${path.join(ROOT_DIR, 'summary.json')}\n`);
    
    for (let page = startPage; page <= endPage; page++) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📄 Processing Page ${page}/${endPage}`);
        console.log(`${'='.repeat(60)}`);
        
        const pageStartTime = Date.now();
        
        try {
            const pageResult = await processSinglePage(page);
            globalSummary.processedPages++;
            globalSummary.totalMoviesFound += pageResult.totalMovies;
            globalSummary.totalSuccessfulDownloads += pageResult.successful;
            globalSummary.totalFailedDownloads += pageResult.failed;
            
            // Add page summary to global summary
            globalSummary.pages.push({
                page: page,
                total_movies: pageResult.totalMovies,
                successful: pageResult.successful,
                failed: pageResult.failed,
                duration_seconds: (Date.now() - pageStartTime) / 1000,
                timestamp: new Date().toISOString()
            });
            
            // Save after each page
            await saveGlobalSummary();
            await saveGlobalErrorLog();
            
        } catch (error) {
            console.error(`Failed to process page ${page}:`, error.message);
            addErrorToLog('page_processing', page, null, error.message);
            
            globalSummary.pages.push({
                page: page,
                total_movies: 0,
                successful: 0,
                failed: 0,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
        
        // Add delay between pages
        if (page < endPage) {
            console.log(`\n⏳ Waiting 0 seconds before next page...`);
            // await sleep(5000);
        }
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ Page processing completed!');
    console.log(`${'='.repeat(60)}`);
    
    // Save final summary and error log
    await saveGlobalSummary();
    await saveGlobalErrorLog();
    
    // Print final statistics
    console.log('\n📊 FINAL STATISTICS:');
    console.log(`  Pages processed: ${globalSummary.processedPages}/${globalSummary.totalPages}`);
    console.log(`  Total movies found: ${globalSummary.totalMoviesFound}`);
    console.log(`  Total successful: ${globalSummary.totalSuccessfulDownloads}`);
    console.log(`  Total failed: ${globalSummary.totalFailedDownloads}`);
    console.log(`  Success rate: ${((globalSummary.totalSuccessfulDownloads / globalSummary.totalMoviesFound) * 100).toFixed(1)}%`);
    console.log(`  Duration: ${globalSummary.duration_seconds.toFixed(1)} seconds`);
    
    await checkDownloadStatus();
}

// Process a single page
async function processSinglePage(page) {
    // Create folder for this page
    const pageFolder = path.join(__dirname, 'pages', String(page));
    await fs.ensureDir(pageFolder);
    
    // Try to find working sitemap URL
    console.log(`📍 Looking for sitemap for page ${page}...`);
    const sitemapResult = await findWorkingSitemapUrl(page);
    
    let movieIds = [];
    
    if (sitemapResult && sitemapResult.data) {
        console.log(`✅ Found sitemap, parsing...`);
        const $ = cheerio.load(sitemapResult.data, { xmlMode: true });
        const uniqueIds = new Set();
        
        $('url').each((i, el) => {
            const $el = $(el);
            const loc = $el.find('loc').text().trim();
            if (loc) {
                const urlParts = loc.split('/');
                const slug = urlParts[urlParts.length - 1];
                if (slug && slug !== '' && !slug.includes('.xml') && !uniqueIds.has(slug)) {
                    uniqueIds.add(slug);
                    movieIds.push(slug);
                }
            }
        });
        
        console.log(`📊 Found ${movieIds.length} unique movie IDs on page ${page}`);
    } else {
        const errorMsg = `Could not find sitemap for page ${page}`;
        console.log(`⚠️  ${errorMsg}`);
        addErrorToLog('sitemap_not_found', page, null, errorMsg);
        movieIds = [];
    }
    
    if (movieIds.length === 0) {
        console.log(`⚠️  No movie IDs found for page ${page}, skipping...`);
        return { totalMovies: 0, successful: 0, failed: 0 };
    }
    
    // Download each movie page
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < movieIds.length; i++) {
        const movieId = movieIds[i];
        const movieUrl = `https://missav.ws/en/actresses/${movieId}`;
        const htmlFilePath = path.join(pageFolder, `${movieId}.html`);
        
        // Check if file already exists
        if (await fs.pathExists(htmlFilePath)) {
            const stats = await fs.stat(htmlFilePath);
            if (stats.size > 1000) {
                console.log(`  ⏭️  [${i + 1}/${movieIds.length}] Skipping ${movieId} - already exists`);
                successCount++;
                continue;
            }
        }
        
        try {
            console.log(`  📥 [${i + 1}/${movieIds.length}] Fetching ${movieId}...`);
            
            // Try multiple URL patterns for the movie page
            const urlsToTry = [
                `https://missav.ws/en/actresses/${movieId}`,
                `https://missav.live/en/actresses/${movieId}`,
                `https://missav.ai/en/actresses/${movieId}`
            ];
            
            let htmlContent = null;
            let successfulUrl = null;
            
            for (const tryUrl of urlsToTry) {
                try {
                    const response = await axios.get(tryUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                        },
                        timeout: 15000
                    });
                    if (response.data && response.data.length > 1000) {
                        htmlContent = response.data;
                        successfulUrl = tryUrl;
                        console.log(`    ✅ Got content from ${tryUrl}`);
                        break;
                    }
                } catch (e) {
                    // Try next URL
                }
            }
            
            if (!htmlContent) {
                throw new Error('Could not fetch from any URL');
            }
            
            await fs.writeFile(htmlFilePath, htmlContent, 'utf-8');
            console.log(`  ✅ Saved: ${movieId}.html (${(htmlContent.length / 1024).toFixed(1)} KB)`);
            successCount++;
            
            // await sleep(1000); // Be respectful
            
        } catch (error) {
            console.error(`  ❌ Failed to fetch ${movieId}: ${error.message}`);
            failCount++;
            
            // Add to error log
            addErrorToLog('movie_fetch', page, movieId, error.message, movieUrl);
            
            const errorFilePath = path.join(pageFolder, `${movieId}.error.txt`);
            await fs.writeFile(errorFilePath, `Error: ${error.message}\nURL: ${movieUrl}\nTime: ${new Date().toISOString()}`, 'utf-8');
        }
    }
    
    console.log(`\n📊 Page ${page} Summary: ✅ ${successCount} | ❌ ${failCount}`);
    
    // Save page summary
    const pageSummary = {
        page: page,
        total_movies: movieIds.length,
        successful_downloads: successCount,
        failed_downloads: failCount,
        timestamp: new Date().toISOString(),
        movie_ids: movieIds.slice(0, 10) // Only save first 10 to keep file small
    };
    
    await fs.writeJson(path.join(pageFolder, '_summary.json'), pageSummary, { spaces: 2 });
    
    return { totalMovies: movieIds.length, successful: successCount, failed: failCount };
}

// Function to check download status
async function checkDownloadStatus() {
    const pagesDir = path.join(__dirname, 'pages');
    if (!await fs.pathExists(pagesDir)) {
        console.log('No pages directory found');
        return;
    }
    
    const pages = await fs.readdir(pagesDir);
    let totalHtml = 0;
    let totalErrors = 0;
    
    console.log('\n📊 DOWNLOAD STATUS:');
    console.log('─'.repeat(60));
    
    for (const page of pages.sort((a,b) => parseInt(a)-parseInt(b))) {
        const pagePath = path.join(pagesDir, page);
        const stat = await fs.stat(pagePath);
        
        if (stat.isDirectory() && !isNaN(parseInt(page))) {
            const files = await fs.readdir(pagePath);
            const htmlFiles = files.filter(f => f.endsWith('.html'));
            const errorFiles = files.filter(f => f.endsWith('.error.txt'));
            
            totalHtml += htmlFiles.length;
            totalErrors += errorFiles.length;
            
            console.log(`Page ${page.padStart(3)}: ${htmlFiles.length} HTML files, ${errorFiles.length} errors`);
        }
    }
    
    console.log('─'.repeat(60));
    console.log(`TOTAL: ${totalHtml} HTML files, ${totalErrors} errors`);
}

// API endpoint to get global error log
app.get('/error-log', async (req, res) => {
    try {
        const errorLogPath = path.join(ROOT_DIR, 'error_log.json');
        if (await fs.pathExists(errorLogPath)) {
            const errorLog = await fs.readJson(errorLogPath);
            res.json(errorLog);
        } else {
            res.json({ message: 'No error log found', errors: [] });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API endpoint to get global summary
app.get('/summary', async (req, res) => {
    try {
        const summaryPath = path.join(ROOT_DIR, 'summary.json');
        if (await fs.pathExists(summaryPath)) {
            const summary = await fs.readJson(summaryPath);
            res.json(summary);
        } else {
            res.json({ message: 'No summary found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ EXPRESS ENDPOINTS ============

app.get('/discover/movie', async (req, res) => {
    try {
        const page = req.query.page || 1;
        const pageFolder = path.join(__dirname, 'pages', String(page));
        
        if (await fs.pathExists(pageFolder)) {
            const files = await fs.readdir(pageFolder);
            const htmlFiles = files.filter(f => f.endsWith('.html'));
            
            const results = htmlFiles.map(file => ({
                id: file.replace('.html', ''),
                title: file.replace('.html', ''),
                local_html: `/pages/${page}/${file}`,
                poster_path: `https://fourhoi.com/${file.replace('.html', '')}/cover.jpg`
            }));
            
            return res.json({ page: parseInt(page), results, total: results.length, source: 'local' });
        }
        
        res.json({ page: parseInt(page), results: [], total: 0, source: 'none' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/download-status', async (req, res) => {
    await checkDownloadStatus();
    res.json({ message: 'Check console for status' });
});

app.get('/pages/:page/:filename', async (req, res) => {
    const filePath = path.join(__dirname, 'pages', req.params.page, req.params.filename);
    if (await fs.pathExists(filePath)) {
        res.sendFile(path.resolve(filePath));
    } else {
        res.status(404).send('File not found');
    }
});

// Start server
app.listen(PORT, async () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📁 Files will be saved in: ${path.join(__dirname, 'pages')}`);
    console.log(`📝 Error log will be saved to: ${path.join(ROOT_DIR, 'error_log.json')}`);
    console.log(`📊 Summary will be saved to: ${path.join(ROOT_DIR, 'summary.json')}`);
    
    // Test FlareSolverr
    const flaresolverrWorking = await testFlareSolverr();
    if (!flaresolverrWorking) {
        console.log('⚠️  FlareSolverr not detected. Will use direct requests.');
        USE_FLARESOLVERR = false;
    }
    
    console.log(`\n⏳ Starting automatic download in 0 seconds...`);
    // await sleep(3000);
    
    // Start downloading
    await processAllPages(1, 10);
});
