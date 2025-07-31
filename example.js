// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

const express = require('express');
const { ChronikClient } = require('chronik-client');
const ChronikCache = require('./dist/src/index.js');

const app = express();
const port = 3080;

// Create ChronikClient instance
const client = new ChronikClient('https://chronik1.alitayin.com.');

// 服务器端BigInt序列化处理函数
function convertBigIntsToStrings(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return obj.toString();
    if (Array.isArray(obj)) return obj.map(convertBigIntsToStrings);
    if (typeof obj === 'object') {
        const converted = {};
        for (const [key, value] of Object.entries(obj)) {
            converted[key] = convertBigIntsToStrings(value);
        }
        return converted;
    }
    return obj;
}

// Create ChronikCache instance
const chronik = new ChronikCache(client, {
    maxTxLimit: 200000,
    wsTimeout: 150000,
    wsExtendTimeout: 1000,
    enableLogging: true,
    enableTimer: true
});

// CSS样式
const CSS_STYLES = `
body {
    font-family: Arial, sans-serif;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
}
.container { margin-top: 20px; }
input[type="text"] {
    width: 500px;
    padding: 8px;
    margin-right: 10px;
}
select {
    padding: 8px;
    margin-right: 10px;
}
button {
    padding: 8px 15px;
    background-color: #4CAF50;
    color: white;
    border: none;
    cursor: pointer;
}
button:hover { background-color: #45a049; }
#result {
    margin-top: 20px;
    white-space: pre-wrap;
}
.page {
    margin-bottom: 20px;
    padding: 10px;
    border: 1px solid #ddd;
}
.page-header {
    cursor: pointer;
    padding: 5px;
    background-color: #f0f0f0;
}
.page-content {
    display: none;
    padding: 10px;
}
.page-content.show { display: block; }
.example-tokens {
    font-size: 12px;
    color: #666;
    margin-top: 5px;
}
.example-tokens code {
    background: #f5f5f5;
    padding: 2px 4px;
    border-radius: 3px;
}
.tx-container {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 8px;
    margin: 10px 0;
}
.tx-item {
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    padding: 8px;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    transition: background-color 0.2s;
}
.tx-item:hover { background: #e9ecef; }
.tx-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
}
.block-height {
    font-size: 10px;
    color: #6c757d;
    background: #e9ecef;
    padding: 2px 6px;
    border-radius: 3px;
    min-width: 60px;
    text-align: center;
    font-weight: 500;
}
#statsResult {
    margin-top: 20px;
    padding: 10px;
    background-color: #f8f9fa;
    border-radius: 4px;
    white-space: pre-wrap;
}
.stats-button {
    background-color: #007bff;
    margin-left: 10px;
}
.stats-button:hover { background-color: #0056b3; }
.modal {
    display: none;
    position: fixed;
    z-index: 1000;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0,0,0,0.4);
}
.modal-content {
    background-color: #fefefe;
    margin: 5% auto;
    padding: 20px;
    border: 1px solid #888;
    width: 90%;
    max-width: 800px;
    max-height: 80%;
    overflow-y: auto;
    border-radius: 8px;
}
.close {
    color: #aaa;
    float: right;
    font-size: 28px;
    font-weight: bold;
    cursor: pointer;
}
.close:hover, .close:focus { color: black; }
.tx-link {
    cursor: pointer;
    color: #007bff;
    text-decoration: underline;
}
.tx-link:hover { color: #0056b3; }
.explorer-link {
    margin-left: 8px;
    font-size: 10px;
    color: #28a745;
    text-decoration: none;
    padding: 1px 4px;
    border-radius: 2px;
    background: #d4edda;
}
.explorer-link:hover { background: #c3e6cb; }
`;

// JavaScript代码
const CLIENT_SCRIPT = `
let currentTxData = {};

function safeStringify(obj, space = 2) {
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'bigint') {
            return value.toString();
        }
        return value;
    }, space);
}

function createTxLink(txid, tx) {
    const abbreviated = txid.slice(0, 4) + "..." + txid.slice(-4);
    currentTxData[txid] = tx;
    return '<span class="tx-link" onclick="showTxDetails(\\"' + txid + '\\")">' + abbreviated + '</span>' +
           '<a href="https://explorer.e.cash/tx/' + txid + '" target="_blank" class="explorer-link">[explorer]</a>';
}

function showTxDetails(txid) {
    const modal = document.getElementById('txModal');
    const detailsDiv = document.getElementById('txDetails');
    const tx = currentTxData[txid];
    if (tx) {
        detailsDiv.innerHTML = '<pre>' + safeStringify(tx, 2) + '</pre>';
        modal.style.display = 'block';
    }
}

function closeTxModal() {
    document.getElementById('txModal').style.display = 'none';
}

window.onclick = function(event) {
    const modal = document.getElementById('txModal');
    if (event.target == modal) {
        modal.style.display = 'none';
    }
}

function generateTxGrid(txs) {
    if (!txs || !Array.isArray(txs) || txs.length === 0) {
        return '<div class="tx-container"><div style="text-align: center; color: #6c757d; padding: 20px;">No transactions found</div></div>';
    }
    
    let html = '<div class="tx-container">';
    html += txs.map(tx => {
        const height = tx.block?.height ?? 'mempool';
        const txLink = createTxLink(tx.txid, tx);
        return '<div class="tx-item">' +
               '<div class="tx-info">' +
               '<div>' + txLink + '</div>' +
               '</div>' +
               '<div class="block-height">' + height + '</div>' +
               '</div>';
    }).join('');
    html += '</div>';
    return html;
}

function togglePageContent(pageHeader) {
    const content = pageHeader.nextElementSibling;
    content.classList.toggle("show");
}

async function fetchWithErrorHandling(url, resultDiv) {
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.error) {
            resultDiv.innerHTML = "Error: " + data.error;
            resultDiv.style.color = "#ff6b6b";
            return null;
        }
        
        if (data.message) {
            resultDiv.innerHTML = "System message: " + data.message;
            resultDiv.style.color = "#ff6b6b";
            return null;
        }
        
        return data;
    } catch (error) {
        resultDiv.innerHTML = "Error: " + error.message;
        resultDiv.style.color = "#ff6b6b";
        return null;
    }
}

function createPageElements(resultDiv) {
    const pageDiv = document.createElement("div");
    pageDiv.className = "page";

    const pageHeader = document.createElement("div");
    pageHeader.className = "page-header";
    pageHeader.onclick = () => togglePageContent(pageHeader);

    const pageContent = document.createElement("div");
    pageContent.className = "page-content";
    pageContent.innerHTML = "Loading...";

    pageDiv.appendChild(pageHeader);
    pageDiv.appendChild(pageContent);
    resultDiv.appendChild(pageDiv);
    
    return { pageHeader, pageContent };
}

async function handleTransactionQuery(queryType, queryInput, queryMode, isNative = false) {
    const pageSize = queryMode === "turbo" && !isNative ? 8000 : 200;
    const endpoint = isNative ? "/native" : "/query";
    
    const params = new URLSearchParams({
        type: queryType,
        input: queryInput,
        pageSize: pageSize,
        page: 0
    });
    
    if (!isNative) params.append('mode', queryMode);
    
    const firstData = await fetchWithErrorHandling(endpoint + "?" + params, document.getElementById("result"));
    if (!firstData) return null;
    
    if (!firstData.txs || !Array.isArray(firstData.txs)) {
        const resultDiv = document.getElementById("result");
        resultDiv.innerHTML = "Error: Invalid response format - missing or invalid txs array";
        resultDiv.style.color = "#ff6b6b";
        return null;
    }
    
    return firstData;
}

async function processAllPages(queryType, queryInput, pageSize, totalPages, isNative = false) {
    const endpoint = isNative ? "/native" : "/query";
    let resultHTML = "";
    
    for (let p = 1; p < totalPages; p++) {
        const params = new URLSearchParams({
            type: queryType,
            input: queryInput,
            pageSize: pageSize,
            page: p
        });
        
        const nextData = await fetchWithErrorHandling(endpoint + "?" + params, document.getElementById("result"));
        
        if (nextData && nextData.txs && Array.isArray(nextData.txs)) {
            resultHTML += "<h3>Request #" + (p + 1) + " (" + nextData.txs.length + " transactions):</h3>";
            resultHTML += generateTxGrid(nextData.txs);
        } else {
            resultHTML += "<h3>Request #" + (p + 1) + ": Error loading data</h3>";
        }
    }
    
    return resultHTML;
}

async function executeQuery(isNative = false) {
    const startTime = Date.now();
    const queryType = document.getElementById("queryType").value;
    const queryInput = document.getElementById("queryInput").value;
    const queryMode = document.getElementById("queryMode").value;
    const resultDiv = document.getElementById("result");

    resultDiv.innerHTML = "";
    const { pageHeader, pageContent } = createPageElements(resultDiv);

    if (queryType === "block") {
        const data = await fetchWithErrorHandling("/block/" + queryInput, pageContent);
        const totalTime = Date.now() - startTime;
        if (data) {
            pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>" + safeStringify(data, 2);
        }
        return;
    }

    const firstData = await handleTransactionQuery(queryType, queryInput, queryMode, isNative);
    if (!firstData) return;

    pageHeader.textContent = "Transactions (Total: " + (firstData.numTxs || firstData.txs.length) + ", Pages: " + (firstData.numPages || 1) + ")";

    let resultHTML = "<h3>Request #1 (" + firstData.txs.length + " transactions):</h3>";
    resultHTML += generateTxGrid(firstData.txs);

    if (!isNative && queryMode === "normal" && firstData.numPages > 1) {
        const pageSize = 200;
        const additionalHTML = await processAllPages(queryType, queryInput, pageSize, firstData.numPages, isNative);
        resultHTML += additionalHTML;
    } else if (isNative && firstData.numPages > 1) {
        const pageSize = 200;
        const additionalHTML = await processAllPages(queryType, queryInput, pageSize, firstData.numPages, isNative);
        resultHTML += additionalHTML;
    }

    const totalTime = Date.now() - startTime;
    pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>Total transactions: " + (firstData.numTxs || firstData.txs.length) + "<br/><br/>" + resultHTML;
}

async function query() {
    await executeQuery(false);
}

async function nativeQuery() {
    await executeQuery(true);
}

async function getStats() {
    try {
        const response = await fetch('/stats');
        const stats = await response.json();
        const statsDiv = document.getElementById('statsResult');
        statsDiv.innerHTML = '<h3>Cache Statistics:</h3>' + 
            '<pre>' + safeStringify(stats, 2) + '</pre>';
    } catch (error) {
        console.error('Error fetching stats:', error);
        document.getElementById('statsResult').innerHTML = 
            'Error fetching statistics: ' + error.message;
    }
}

document.getElementById("queryType").addEventListener("change", function(e) {
    const input = document.getElementById("queryInput");
    const exampleNote = document.getElementById("exampleNote");
    
    const configs = {
        address: {
            placeholder: "Enter eCash address...",
            value: "ecash:qr6lws9uwmjkkaau4w956lugs9nlg9hudqs26lyxkv",
            note: "Display latest 4000 transactions"
        },
        p2pkh: {
            placeholder: "Enter Public Key Hash...",
            value: "",
            note: "Display latest 4000 transactions"
        },
        p2sh: {
            placeholder: "Enter Script Hash...",
            value: "",
            note: "Display latest 4000 transactions"
        },
        token: {
            placeholder: "Enter Token ID...",
            value: "",
            note: "Example Token ID: <code>7e7dacd72dcdb14e00a03dd3aff47f019ed51a6f1f4e4f532ae50692f62bc4dd</code>"
        },
        block: {
            placeholder: "Enter block hash...",
            value: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
            note: "Example: Bitcoin Genesis block hash"
        }
    };
    
    const config = configs[e.target.value];
    if (config) {
        input.placeholder = config.placeholder;
        input.value = config.value;
        exampleNote.innerHTML = config.note;
    }
});
`;

// HTML页面生成函数
function generateHTML() {
    return `<!DOCTYPE html>
<html>
<head>
    <title>eCash Transaction History</title>
    <style>${CSS_STYLES}</style>
</head>
<body>
    <h1>eCash Transaction History Query</h1>
    <div class="container">
        <select id="queryType">
            <option value="address">Address Query</option>
            <option value="p2pkh">P2PKH Query</option>
            <option value="p2sh">P2SH Query</option>
            <option value="token">Token Query</option>
            <option value="block">Block Query</option>
        </select>
        <select id="queryMode" style="margin-left: 10px;">
            <option value="normal">Normal Mode (200/page)</option>
            <option value="turbo">Turbo Mode (8000/page)</option>
        </select>
        <input type="text" id="queryInput" placeholder="Enter query content..." 
            value="ecash:qr6lws9uwmjkkaau4w956lugs9nlg9hudqs26lyxkv">
        <button onclick="query()">Query</button>
        <button onclick="nativeQuery()">Native Mode</button>
        <button onclick="getStats()" class="stats-button">Get Cache Stats</button>
        <div class="example-tokens" id="exampleNote">
            Display latest 4000 transactions
        </div>
    </div>
    <div id="statsResult"></div>
    <div id="result"></div>

    <div id="txModal" class="modal">
        <div class="modal-content">
            <span class="close" onclick="closeTxModal()">&times;</span>
            <h3>Transaction Details</h3>
            <div id="txDetails"></div>
        </div>
    </div>

    <script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

// 设置静态文件目录
app.use(express.static('public'));

// 提供HTML页面
app.get('/', (_req, res) => {
    res.send(generateHTML());
});

// 通用查询处理函数
async function handleQuery(req, res, useCache = true) {
    try {
        const { type, input, page = 0, mode = "normal" } = req.query;
        
        if (!input) {
            return res.status(400).json({ error: "Input is required" });
        }

        const actualPageSize = mode === "turbo" && useCache ? 8000 : 200;
        const queryClient = useCache ? chronik : client;
        
        let result;
        switch (type) {
            case "address":
                result = await queryClient.address(input).history(parseInt(page), actualPageSize);
                break;
            case "p2pkh":
            case "p2sh":
                result = await queryClient.script(type, input).history(parseInt(page), actualPageSize);
                break;
            case "token":
                result = await queryClient.tokenId(input).history(parseInt(page), actualPageSize);
                break;
            default:
                return res.status(400).json({ error: "Unsupported query type" });
        }
        
        const convertedResult = convertBigIntsToStrings(result);
        res.json(convertedResult);
    } catch (error) {
        if (error.message.includes("out of range")) {
            return res.status(400).json({ 
                error: error.message,
                code: "PAGE_OUT_OF_RANGE"
            });
        }
        res.status(500).json({ error: error.message });
    }
}

// API路由
app.get("/query", (req, res) => handleQuery(req, res, true));
app.get("/native", (req, res) => handleQuery(req, res, false));

app.get("/block/:hash", async (req, res) => {
    try {
        const blockHash = req.params.hash;
        const result = await client.block(blockHash);
        const convertedResult = convertBigIntsToStrings(result);
        res.json(convertedResult);
    } catch (error) {
        res.status(500).json({ 
            error: error.message,
            message: "Block query failed"
        });
    }
});

app.get('/stats', async (_req, res) => {
    try {
        const stats = await chronik.getStatistics();
        const convertedStats = convertBigIntsToStrings(stats);
        res.json(convertedStats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 启动服务器
app.listen(port, () => {
    console.log("Server running at http://localhost:" + port);
});
