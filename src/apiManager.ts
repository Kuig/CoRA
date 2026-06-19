import { logError, logWarning } from './logger';

export interface AcademicPaper {
    title: string;
    abstract: string;
    doi?: string;
    url?: string;
    source: 'arXiv' | 'Semantic Scholar' | 'DuckDuckGo';
    year?: number;
    citationCount?: number;
}

export class ApiManager {
    /**
     * Searches academic papers on arXiv.
     */
    public async searchArxiv(query: string, maxResults: number = 5): Promise<AcademicPaper[]> {
        try {
            const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;
            const response = await fetch(url);
            if (!response.ok) {
                logWarning(`arXiv search returned status ${response.status}: ${response.statusText}`);
                return [];
            }
            const text = await response.text();
            
            const entries = text.split('<entry>').slice(1);
            return entries.map(entry => {
                const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
                const abstractMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
                const doiMatch = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
                const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
                const yearMatch = entry.match(/<published>(\d{4})-[^<]*<\/published>/);
                
                return {
                    title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'Unknown Title',
                    abstract: abstractMatch ? abstractMatch[1].replace(/\s+/g, ' ').trim() : '',
                    doi: doiMatch ? doiMatch[1].trim() : undefined,
                    url: idMatch ? idMatch[1].trim() : undefined,
                    source: 'arXiv',
                    year: yearMatch ? parseInt(yearMatch[1]) : undefined
                };
            });
        } catch (e: any) {
            logError(`arXiv search failed: ${e?.message || e}`);
            return [];
        }
    }

    private _lastRequestTime = 0;
    private _rateLimitQueue: Promise<any> = Promise.resolve();

    private async _waitForRateLimit(): Promise<void> {
        const now = Date.now();
        const timeSinceLast = now - this._lastRequestTime;
        const timeToWait = 1000 - timeSinceLast;
        if (timeToWait > 0) {
            await new Promise(resolve => setTimeout(resolve, timeToWait));
        }
        this._lastRequestTime = Date.now();
    }

    private async _fetchSemanticScholarWithRetry(
        query: string,
        maxResults: number,
        apiKey?: string
    ): Promise<AcademicPaper[]> {
        const maxRetries = 3;
        let attempt = 0;
        let delay = 1000;

        while (true) {
            try {
                await this._waitForRateLimit();

                const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=title,abstract,externalIds,url,year,citationCount`;
                
                const headers: Record<string, string> = {
                    'User-Agent': 'CoRA-VSCode-Extension (https://github.com/Kuig/CoRA)'
                };
                if (apiKey) {
                    headers['x-api-key'] = apiKey;
                }

                const response = await fetch(url, { headers });
                if (!response.ok) {
                    if (response.status === 429) {
                        if (apiKey) {
                            logWarning(`Semantic Scholar API returned 429 (Too Many Requests) even with API key. You may have exceeded the authenticated rate limit (1 req/s). The request will be retried with exponential backoff.`);
                        } else {
                            logWarning(`Semantic Scholar API returned 429 (Too Many Requests). Configure 'cora.semanticScholarApiKey' in VS Code settings to get a higher rate limit.`);
                        }
                    } else {
                        logWarning(`Semantic Scholar search returned status ${response.status}: ${response.statusText}`);
                    }
                    throw new Error(`HTTP status ${response.status}`);
                }
                const data = await response.json() as any;
                
                if (!data || !data.data) {
                    return [];
                }
                
                return data.data.map((paper: any) => ({
                    title: paper.title || 'Unknown Title',
                    abstract: paper.abstract || '',
                    doi: paper.externalIds?.DOI,
                    url: paper.url,
                    source: 'Semantic Scholar',
                    year: paper.year,
                    citationCount: paper.citationCount
                }));
            } catch (error: any) {
                attempt++;
                if (attempt > maxRetries) {
                    logError(`Semantic Scholar search failed after ${maxRetries} retries: ${error?.message || error}`);
                    throw error;
                }
                
                logWarning(`Semantic Scholar search attempt ${attempt} failed: ${error?.message || error}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff: 1000ms -> 2000ms -> 4000ms
            }
        }
    }

    /**
     * Searches academic papers on Semantic Scholar.
     */
    public async searchSemanticScholar(query: string, maxResults: number = 5, apiKey?: string): Promise<AcademicPaper[]> {
        return new Promise<AcademicPaper[]>((resolve) => {
            this._rateLimitQueue = this._rateLimitQueue
                .then(async () => {
                    try {
                        const papers = await this._fetchSemanticScholarWithRetry(query, maxResults, apiKey);
                        resolve(papers);
                    } catch (e: any) {
                        resolve([]);
                    }
                })
                .catch((err) => {
                    logError(`Queue error: ${err}`);
                    resolve([]);
                });
        });
    }

    /**
     * Searches academic papers or general web pages on DuckDuckGo using HTML scraping.
     */
    public async searchDuckDuckGo(query: string, maxResults: number = 5): Promise<AcademicPaper[]> {
        try {
            const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            if (!response.ok) {
                logWarning(`DuckDuckGo search returned status ${response.status}: ${response.statusText}`);
                return [];
            }
            const html = await response.text();
            
            const results: AcademicPaper[] = [];
            const resultBlockRegex = /<div class="result results_links results_links_deep web-result ">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
            
            let match;
            while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
                const blockContent = match[1];
                
                // Extract Title & Link
                const linkTitleRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
                const linkTitleMatch = linkTitleRegex.exec(blockContent);
                if (!linkTitleMatch) {
                    continue;
                }
                
                const rawUrl = linkTitleMatch[1];
                const title = linkTitleMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                
                // Extract Snippet
                const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/;
                const snippetMatch = snippetRegex.exec(blockContent);
                const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
                
                // Parse target URL from DuckDuckGo redirect link
                let decodedUrl = rawUrl;
                if (rawUrl.includes('uddg=')) {
                    try {
                        const params = new URLSearchParams(rawUrl.substring(rawUrl.indexOf('?')));
                        const uddg = params.get('uddg');
                        if (uddg) {
                            decodedUrl = uddg;
                        }
                    } catch (e) {
                        // fallback
                    }
                } else if (rawUrl.startsWith('//')) {
                    decodedUrl = 'https:' + rawUrl;
                }
                
                results.push({
                    title,
                    abstract: snippet,
                    url: decodedUrl,
                    source: 'DuckDuckGo'
                });
            }
            
            return results;
        } catch (e: any) {
            logError(`DuckDuckGo search failed: ${e?.message || e}`);
            return [];
        }
    }
}

