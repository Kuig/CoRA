# CoRA (Context Retrieval Aid)

CoRA is a Visual Studio Code extension designed to **assist writing** complex documents (theses, papers, technical documentation) in a non-obtrusive and highly contextual way.

Unlike traditional AI assistants that generate new text for you (often introducing hallucinations or altering your style), CoRA follows a different philosophy: **AI should not write for you, but it should help you find the right information at the right time.**

Using techniques derived from RAG, CoRA analyzes what you are writing (or what you have selected) and instantly retrieves relevant snippets from **your personal sources** or the **Web**, presenting them in a side panel.

CoRA has an optional dependency called **TextConverter**. It is a lightweight python package that can be used to convert various file formats to markdown, and I haven't released it yet. Sorry. 

---

## Typical usage

0. You must have Ollama running an embedding model in the background (e.g. `bge-m3` or `embeddinggemma`). Sorry again, I know, I should support other providers. It will happen one day. In the meantime you can fork this and vibe-code your way to llama.cpp.
1. Create a folder named `Sources` in your workspace.
2. Copy all your reference documents, notes, and papers into the `Sources` folder (supports `.md`, `.txt`, and `.tex` files. With TextConverter, it also supports `.pdf`, `.html`, and `.htm` files).
3. Create an empty `.md` file in your workspace and start writing.

**Pro tip**: Put the `.md` file you are working on in the `Sources` folder too. That way, CoRA will index its last saved version, allowing you to get suggestions from the very document you are writing!

---

## ✨ Key Features

- **Autonomous Smart Context**: Write in your editor. CoRA will extract the context of the paragraph you are working on and suggest the most relevant texts from your reference documents.
- **100% Local Privacy and RAG**: Works entirely offline thanks to integration with [Ollama](https://ollama.com/). Your documents never leave your computer.
- **Smart Web Search**: Using an advanced algorithm based on **Maximum Marginal Relevance (MMR)**, CoRA extracts keywords from your text and allows you to query academic repositories (arXiv, Semantic Scholar) and the Web (DuckDuckGo).
  - *Note: Semantic Scholar queries can hit rate limits; you can configure an API key in the settings to prevent 'Too Many Requests' (429) errors.*
  - DuckDuckGo results can be downloaded and converted directly to clean Markdown using **TextConverter**. If TextConverter is not available or fails, it falls back to saving a standard placeholder with the search snippet and URL.
  - Add search results as new local sources (generating a Markdown file) or cite the DOI directly.
- **Citation Support (BibTeX)**: If a snippet (local or web) comes from a document that has a DOI identifier or a URL metadata header, you can click the **Cite** button to automatically generate the reference in your project's `.bib` file and insert `\cite{key}`. DOIs are resolved online via Crossref, whereas URLs generate an offline `@misc` BibTeX entry.
- **(Almost-)Native PDF and HTML Support**: Drag your `.pdf`, `.html`, or `.htm` papers into the `Sources` folder. If TextConverter is available, it will automatically convert them to text format (**discarding images**), and move the original file to `Sources/Processed`.
- **LaTeX Support**: `.tex` files in the `Sources` folder are parsed and vectorized directly by the RAG engine without external conversion.
- **Optimized Workflow**:
  - Automatically activates when opening `.md`, `.tex`, or `.latex` files.
  - Click a suggested snippet to: **copy it**, **insert it** directly at the editor cursor, or **open the original source file** to read the full context.
  - **Pin** system to lock crucial snippets at the top, and **Hide** system to obscure irrelevant ones.
- **Real-Time Control Panel**:
  - **Similarity Threshold (10% - 90%)**: Instantly adjust via a slider how "strict" CoRA should be in filtering semantic matches.
  - **Response Delay (1s - 10s)**: Customize the wait time before CoRA analyzes your text once you stop writing.
  - Easily configure web search sources, max results, and PDF options; everything is persistently saved in the local `project_settings.json`.
- **Decent Performance & Vector Caching**: Integrated binary vector caching (via automatic Base64 encoding) guarantees near-instant loading times. Vectors are saved in the `.cora/cache.json` file along with the active model's name. If you change the model in VS Code settings, CoRA automatically invalidates the cache and recalculates the vectors in real-time without needing to restart the IDE.
- **Auto-Update Checker & GitHub Releases Automation**: Automatically checks GitHub Releases on startup to notify you when a new version of CoRA is available. Features a pre-configured GitHub Actions workflow that automatically packages and publishes `.vsix` binaries to new GitHub Releases when version tags (e.g. `v0.1.0`) are pushed.

---

## 🚀 How to Get Started (Setup)

1. **Prerequisites (Ollama and Python)**
   - Make sure you have [Ollama](https://ollama.com/) installed and running in the background on your computer.
   - Open your terminal and download a lightweight embedding model by running (e.g.):
     ```bash
     ollama pull bge-m3
     ```
   - For automatic document conversion, ensure TextConverter is installed as a console command `textconverter` or set `cora.textconverterPath` to the path of the TextConverter root directory (e.g. `...\TextConverter`). CoRA will automatically run it using its internal virtual environment (`.venv`) if available.
   - In the plugin settings, you can configure:
      - `cora.embeddingsModel`: The local Ollama model to use for generating embeddings (default: `bge-m3`). *Note: Changing this value will automatically invalidate the vector cache in real-time to recalculate the embeddings.*
      - `cora.ollamaPort`: The local port where the Ollama server is running (default: `11434`).
      - `cora.semanticScholarApiKey`: Optional API key to prevent rate limiting errors (HTTP 429) when searching Semantic Scholar (default: `""`).
      - `cora.textconverterPath`: Absolute path to the TextConverter project root directory.
      - `cora.textconverterCodeParsing`: If active, attempts to detect code blocks during conversion (default: true).
      - `cora.textconverterExtractHtml`: If active, extracts only the main content from HTML pages (default: true).
      - `cora.stripLinksAndImages`: If active, strips Markdown links (keeping only the link text) and removes Markdown images from the converted source documents (default: true).
      - `cora.filterTitles`: If active, excludes headings/titles (lines starting with one or more `#`) from the Smart Context suggestions (default: true).
      - `cora.autoOpenPanel`: If active, automatically opens the CoRA side panel in the background when conditions are met (e.g., when opening a Markdown or LaTeX file in a workspace containing a `Sources` folder). If disabled, you can open the panel manually via the Command Palette (`Ctrl+Shift+P` -> `CoRA: Open Smart Context Panel`) (default: true).
2. **Workspace Configuration**
   - Open a project in VS Code.
   - Create a folder named `Sources` in the root directory of your workspace.
   - Copy all your reference documents, notes, and papers into the `Sources` folder (supports `.md`, `.txt`, `.pdf`, `.tex`, `.html`, and `.htm` files).
3. **Setting Up DOI and URL Metadata**
   - To enable automated citations, local Markdown source files **must** have their DOI or URL written on the very **first line** of the file in one of the following formats:
     ```markdown
     doi: 10.xxxx/yyyyyy
     ```
     or
     ```markdown
     url: https://example.com/some-page
     ```
     followed by the document body starting on the next lines.
   - CoRA will automatically detect this header line, store it as metadata, and prevent it from being sent to Ollama for embedding. Files generated from Web Search Results already follow this structure automatically.
4. **Supported Files in Sources**
   - `.md`, `.txt`, and `.tex` are read and vectorized directly.
   - `.pdf`, `.html`, and `.htm` are automatically converted to Markdown using TextConverter and stored in `Sources/Processed`.
5. **Usage**
   - Open a Markdown (`.md`) or LaTeX (`.tex`) file. The CoRA side panel will detect the `Sources` folder and open automatically, starting the source synchronization.
   - Once the indexing banner disappears, simply start writing!

*(Note: alternatively, you can always open the interface manually via the Command Palette `Ctrl+Shift+P` -> `CoRA: Open Smart Context Panel`)*.

---

## 🛠️ Architecture and Module Structure

The source files are located in the `src` folder and follow a clear logical division of modules:

*   **`extension.ts`**: The entry point of the extension. It initializes the managers, configures the native logger with the OutputChannel, listens to editor events (cursor movement and text selection with debouncing), and bridges the Webview UI with the TypeScript backend. It also manages the real-time configuration change listener.
*   **`webview.ts`**: UI controller and view (in HTML/JS). Intercepts inputs (sliders, checkboxes, buttons for Pin/Hide/Cite) and dispatches commands to the extension using `postMessage`. It splits the panel into "Smart Context" and "Web Results".
*   **`ragEngine.ts`**: The core RAG engine in RAM. Interfaces with Ollama to calculate embeddings (including batching) and calculates *Cosine Similarity*, excluding snippets flagged as `pinned` or `hidden`. It handles dynamic model and port configuration for Ollama.
*   **`fileManager.ts`**: Handles I/O operations. Scans the `Sources` directory (excluding `Sources/Processed`), extracts DOI metadata, and manages the incremental cache (`mtime`). It uses the `VectorCache` class to load, save, and invalidate AI records.
*   **`settingsManager.ts`**: Initializes and manipulates the local configuration file `.cora/project_settings.json` via the `ProjectSettings` class.
*   **`keywordExtractor.ts`**: Generates N-grams (unigrams/bigrams/trigrams) from the context text and uses the **MMR (Maximal Marginal Relevance)** algorithm to extract diversified keywords.
*   **`apiManager.ts`**: Handles external fetching for web searches via *arXiv*, *Semantic Scholar*, and *DuckDuckGo*.
*   **`bibtexManager.ts`**: Manages the import of references in `.bib` format. For DOIs, it downloads data from `doi.org`/Crossref; for URLs, it generates a local `@misc` entry offline. It then inserts the `\cite{}` command into the active editor.
*   **`documentConverter.ts`**: Spawns the external `TextConverter` tool (preferring the `textconverter` CLI command or falling back to `python -m textconverter`) to convert PDF, HTML/HTM files, and web URLs to Markdown, storing them in the `Sources` directory (local documents are moved to `Sources/Processed` post-conversion).
*   **`editorUtils.ts`**: Utilities for text editor operations, including robust tracking and retrieval of the last active text editor when the webview panel has focus.
*   **`logger.ts`**: Unified logger conforming to the _UnifyTools suite conventions, supporting `vscode.OutputChannel` and status bar message dispatch to the Webview.

---

## 🔄 Main Data Flows

### 1. Initialization and State Restore
1. At extension startup, `SettingsManager` reads user parameters, and the active model and Ollama port are resolved (falling back to VS Code global settings).
2. `RagEngine` is initialized, configuring endpoints dynamically.
3. `FileManager` performs a differential scan of the binary cache. If the cached model differs from the active one, the cache is invalidated (saving an empty file) and documents are fully re-vectorized.
4. The Webview sends `'ready'` and receives `'restoreState'` to populate the UI with Pinned, Hidden items, and current settings.

### 2. Dynamic Configuration Update
1. The `onDidChangeConfiguration` listener in `extension.ts` catches changes to `cora.embeddingsModel` or `cora.ollamaPort`.
2. Clears the vectors from RAM in `RagEngine`, updates endpoints (resetting `_isReady` to false), deactivates the active file watcher, and re-initializes `FileManager`.
3. `FileManager` detects the model change via the cache metadata, invalidates the cache in real-time, and triggers background re-vectorization of the sources, instantly re-running the RAG query on the active writing context.

### 3. Dynamic Query (Smart Context)
1. The cursor moves or the user highlights text. `extension.ts` captures the text after a debouncing delay.
2. `RagEngine` fetches the query embedding from Ollama, calculates *Cosine Similarity* against RAM vectors (excluding `pinned` or `hidden` snippets), and sends the sorted list of matching results to the Webview.
3. If the user clicks "Pin" or "Hide", the Webview notifies the extension; `FileManager` updates the state in the cache and `RagEngine` moves the record to the top or hides it from automatic searches.

### 4. Web Search (Keyword Extraction and Citation)
1. The user presses `Search Web`. `extension.ts` extracts keywords using `KeywordExtractor` (MMR).
2. Queries are dispatched to `ApiManager` (arXiv, Semantic Scholar, and DuckDuckGo) and injected into the "Web Results" panel in the Webview.
3. The user has 3 choices:
   - **Visit**: Opens the page in the default Browser.
   - **Cite**: Queries `BibtexManager` (via `doi.org`/Crossref for DOIs, or generating offline `@misc` entries for URLs) to append the reference to the `.bib` file and insert `\cite{}` in the editor.
   - **Add**: Creates a local text record in `Sources/` (via `DocumentConverter` page-to-markdown conversion for DuckDuckGo, or standard abstract saving for arXiv / Semantic Scholar) with `doi: XXX` or `url: YYY` at the top if present, forcing a Watcher update to integrate the document into the local RAG engine.
