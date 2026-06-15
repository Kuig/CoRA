import { RagEngine } from './ragEngine';

export class KeywordExtractor {
    private _ragEngine: RagEngine;
    private _stopwordEmbedding: number[] | null = null;
    private readonly STOPWORD_SAMPLE = "un uno una il lo la i gli le di a da in con su per tra fra e o ma se questo questi quella quelle più del dello della degli delle the a an of in on at for and or but from to with as if then this that";

    constructor(ragEngine: RagEngine) {
        this._ragEngine = ragEngine;
    }

    private async _getStopwordEmbedding(): Promise<number[]> {
        if (!this._stopwordEmbedding) {
            const embeddings = await this._ragEngine.getEmbeddings([this.STOPWORD_SAMPLE]);
            if (embeddings.length > 0) {
                this._stopwordEmbedding = embeddings[0];
            }
        }
        return this._stopwordEmbedding || [];
    }

    /**
     * Extracts keywords from the input text using n-grams and Maximal Marginal Relevance (MMR).
     */
    public async extractKeywords(text: string, topN: number = 5): Promise<string[]> {
        // 1. Logical segmentation (split by strong punctuation)
        const segments = text.toLowerCase().split(/[.,;:!?\n\r()[\]{}]+/);

        let uniqueWords = new Set<string>();
        const segmentWordsList: string[][] = [];

        // Extract per-segment to prevent boundary word fusion
        for (const segment of segments) {
            const words = segment.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2);
            segmentWordsList.push(words);
            words.forEach(w => uniqueWords.add(w));
        }

        const uniqueWordArray = Array.from(uniqueWords);
        if (uniqueWordArray.length === 0) {
            return [];
        }

        // 2. Zero-Shot Stopword Filtering on individual unigrams
        const wordEmbeddings = await this._ragEngine.getEmbeddings(uniqueWordArray);
        const eStop = await this._getStopwordEmbedding();
        const STOPWORD_THRESHOLD = 0.4;

        const validWords = new Set<string>();
        for (let i = 0; i < uniqueWordArray.length; i++) {
            if (eStop.length > 0) {
                const stopwordSimilarity = this._ragEngine.cosineSimilarity(wordEmbeddings[i], eStop);
                if (stopwordSimilarity <= STOPWORD_THRESHOLD) {
                    validWords.add(uniqueWordArray[i]);
                }
            } else {
                validWords.add(uniqueWordArray[i]);
            }
        }

        // 3. N-gram Generation (using valid words only)
        let candidates = new Set<string>();
        for (const words of segmentWordsList) {
            const filtered = words.filter(w => validWords.has(w));

            // Unigrams
            filtered.forEach(w => candidates.add(w));
            // Bigrams
            for (let i = 0; i < filtered.length - 1; i++) {
                candidates.add(`${filtered[i]} ${filtered[i + 1]}`);
            }
            // Trigrams
            for (let i = 0; i < filtered.length - 2; i++) {
                candidates.add(`${filtered[i]} ${filtered[i + 1]} ${filtered[i + 2]}`);
            }
        }

        const candidateArray = Array.from(candidates);
        if (candidateArray.length === 0) {
            return [];
        }

        // 4. Compute embeddings for full document text and candidate list
        const embeddings = await this._ragEngine.getEmbeddings([text, ...candidateArray]);
        if (embeddings.length === 0) {
            return [];
        }

        const eDoc = embeddings[0];
        const eCand = embeddings.slice(1);

        // 5. Cosine similarity calculation of candidates against the full document
        let scoredCandidates: { term: string; score: number; embedding: number[] }[] = [];
        for (let i = 0; i < candidateArray.length; i++) {
            const candEmbedding = eCand[i];
            const score = this._ragEngine.cosineSimilarity(eDoc, candEmbedding);
            scoredCandidates.push({
                term: candidateArray[i],
                score: score,
                embedding: candEmbedding
            });
        }

        // 6. Maximal Marginal Relevance (MMR) diversification
        const lambda = 0.4; // 0: max diversity; 1: max relevance

        const selectedKeywords: string[] = [];
        const selectedEmbeddings: number[][] = [];

        // Start with the highest-scoring candidate
        scoredCandidates.sort((a, b) => b.score - a.score);

        while (selectedKeywords.length < topN && scoredCandidates.length > 0) {
            let bestIndex = -1;
            let bestMmrScore = -Infinity;

            for (let i = 0; i < scoredCandidates.length; i++) {
                const cand = scoredCandidates[i];

                // Avoid selecting sub-strings or exact overlaps of already selected keywords
                let hasOverlap = false;
                for (const sel of selectedKeywords) {
                    if (sel.includes(cand.term) || cand.term.includes(sel)) {
                        hasOverlap = true;
                        break;
                    }
                }
                if (hasOverlap) {
                    continue;
                }

                let maxSimWithSelected = 0;

                for (const selEmb of selectedEmbeddings) {
                    const sim = this._ragEngine.cosineSimilarity(cand.embedding, selEmb);
                    if (sim > maxSimWithSelected) {
                        maxSimWithSelected = sim;
                    }
                }

                const mmrScore = lambda * cand.score - (1 - lambda) * maxSimWithSelected;
                if (mmrScore > bestMmrScore) {
                    bestMmrScore = mmrScore;
                    bestIndex = i;
                }
            }

            if (bestIndex !== -1) {
                const chosen = scoredCandidates[bestIndex];
                selectedKeywords.push(chosen.term);
                selectedEmbeddings.push(chosen.embedding);
                scoredCandidates.splice(bestIndex, 1);
            } else {
                break;
            }
        }

        return selectedKeywords;
    }
}
