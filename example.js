const express = require('express');
const { ChronikClient } = require('chronik-client');
const ChronikCache = require('./dist/src/index.js');

const app = express();
const port = 3080;

// Create a single ChronikClient instance
const client = new ChronikClient('https://chronik1.alitayin.com.');

// 服务器端BigInt序列化处理函数
function convertBigIntsToStrings(obj) {
    if (obj === null || obj === undefined) {
        return obj;
    }
    
    if (typeof obj === 'bigint') {
        return obj.toString();
    }
    
    if (Array.isArray(obj)) {
        return obj.map(convertBigIntsToStrings);
    }
    
    if (typeof obj === 'object') {
        const converted = {};
        for (const [key, value] of Object.entries(obj)) {
            converted[key] = convertBigIntsToStrings(value);
        }
        return converted;
    }
    
    return obj;
}

// Create a ChronikCache instance using the single client
const chronik = new ChronikCache(client, {
  maxTxLimit: 200000,      // Maximum number of records to cache
  wsTimeout: 150000,    // Initial WebSocket timeout (ms)
  wsExtendTimeout: 1000,  // Extended WebSocket timeout (ms)
  enableLogging : true,
  enableTimer: true
});

// 设置静态文件目录
app.use(express.static('public'));

// 提供HTML页面
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
        <html>
        <head>
            <title>eCash Transaction History</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    max-width: 800px;
                    margin: 0 auto;
                    padding: 20px;
                }
                .container {
                    margin-top: 20px;
                }
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
                button:hover {
                    background-color: #45a049;
                }
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
                .page-content.show {
                    display: block;
                }
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
                /* Added styles for transaction list layout */
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
                .tx-item:hover {
                    background: #e9ecef;
                }
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
                /* 添加统计数据样式 */
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
                .stats-button:hover {
                    background-color: #0056b3;
                }
                /* 添加交易详情modal样式 */
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
                .close:hover,
                .close:focus {
                    color: black;
                }
                .tx-link {
                    cursor: pointer;
                    color: #007bff;
                    text-decoration: underline;
                }
                .tx-link:hover {
                    color: #0056b3;
                }
                .explorer-link {
                    margin-left: 8px;
                    font-size: 10px;
                    color: #28a745;
                    text-decoration: none;
                    padding: 1px 4px;
                    border-radius: 2px;
                    background: #d4edda;
                }
                .explorer-link:hover {
                    background: #c3e6cb;
                }
            </style>
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

            <!-- 添加modal用于显示交易详情 -->
            <div id="txModal" class="modal">
                <div class="modal-content">
                    <span class="close" onclick="closeTxModal()">&times;</span>
                    <h3>Transaction Details</h3>
                    <div id="txDetails"></div>
                </div>
            </div>

            <script>
                // 存储当前的交易数据
                let currentTxData = {};

                // 处理BigInt序列化的辅助函数
                function safeStringify(obj, space = 2) {
                    return JSON.stringify(obj, (key, value) => {
                        if (typeof value === 'bigint') {
                            return value.toString();
                        }
                        return value;
                    }, space);
                }

                // Returns a clickable link with abbreviated txid
                function createTxLink(txid, tx) {
                    const abbreviated = txid.slice(0, 4) + "..." + txid.slice(-4);
                    // 存储交易数据以供modal使用
                    currentTxData[txid] = tx;
                    return '<span class="tx-link" onclick="showTxDetails(&quot;' + txid + '&quot;)">' + abbreviated + '</span>' +
                           '<a href="https://explorer.e.cash/tx/' + txid + '" target="_blank" class="explorer-link">[explorer]</a>';
                }

                // 显示交易详情modal
                function showTxDetails(txid) {
                    const modal = document.getElementById('txModal');
                    const detailsDiv = document.getElementById('txDetails');
                    
                    const tx = currentTxData[txid];
                    if (tx) {
                        detailsDiv.innerHTML = '<pre>' + safeStringify(tx, 2) + '</pre>';
                        modal.style.display = 'block';
                    }
                }

                // 关闭交易详情modal
                function closeTxModal() {
                    document.getElementById('txModal').style.display = 'none';
                }

                // 点击modal外部关闭
                window.onclick = function(event) {
                    const modal = document.getElementById('txModal');
                    if (event.target == modal) {
                        modal.style.display = 'none';
                    }
                }

                // Generate grid layout for a set of transactions
                function generateTxGrid(txs) {
                    // 安全检查
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

                async function query() {
                    // 开始计时
                    const startTime = Date.now();
                    
                    const queryType = document.getElementById("queryType").value;
                    const queryInput = document.getElementById("queryInput").value;
                    const queryMode = document.getElementById("queryMode").value;
                    const resultDiv = document.getElementById("result");

                    resultDiv.innerHTML = "";

                    try {
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

                        if (queryType === "block") {
                            const response = await fetch("/block/" + queryInput);
                            const data = await response.json();
                            const totalTime = Date.now() - startTime;
                            if (data.error) {
                                pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>Error: " + data.message;
                                pageContent.style.color = "#ff6b6b";
                            } else {
                                pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>" + safeStringify(data, 2);
                            }
                        } else {
                            const pageSize = queryMode === "turbo" ? 8000 : 200;
                            const queryParams = new URLSearchParams({
                                type: queryType,
                                input: queryInput,
                                pageSize: pageSize,
                                mode: queryMode,
                                page: 0
                            });

                            const firstResponse = await fetch("/query?" + queryParams);
                            const firstData = await firstResponse.json();

                            // 添加错误处理
                            if (firstData.error) {
                                pageContent.innerHTML = "Error: " + firstData.error;
                                pageContent.style.color = "#ff6b6b";
                                return;
                            }

                            if (firstData.message) {
                                pageContent.innerHTML = "System message: " + firstData.message;
                                pageContent.style.color = "#ff6b6b";
                                return;
                            }

                            // 安全检查txs数组
                            if (!firstData.txs || !Array.isArray(firstData.txs)) {
                                pageContent.innerHTML = "Error: Invalid response format - missing or invalid txs array";
                                pageContent.style.color = "#ff6b6b";
                                return;
                            }

                            pageHeader.textContent = "Transactions (Total: " + (firstData.numTxs || firstData.txs.length) + ", Pages: " + (firstData.numPages || 1) + ")";

                            let resultHTML = "";
                            if (queryMode === "normal") {
                                // Display each request's result with a sequence number
                                const totalPages = firstData.numPages || 1;
                                resultHTML += "<h3>Request #1 (" + firstData.txs.length + " transactions):</h3>";
                                resultHTML += generateTxGrid(firstData.txs);

                                for (let p = 1; p < totalPages; p++) {
                                    const nextParams = new URLSearchParams({
                                        type: queryType,
                                        input: queryInput,
                                        pageSize: pageSize,
                                        mode: queryMode,
                                        page: p
                                    });
                                    const nextResponse = await fetch("/query?" + nextParams);
                                    const nextData = await nextResponse.json();
                                    
                                    // 安全检查
                                    if (nextData.txs && Array.isArray(nextData.txs)) {
                                        resultHTML += "<h3>Request #" + (p + 1) + " (" + nextData.txs.length + " transactions):</h3>";
                                        resultHTML += generateTxGrid(nextData.txs);
                                    } else {
                                        resultHTML += "<h3>Request #" + (p + 1) + ": Error loading data</h3>";
                                    }
                                }
                                const totalTime = Date.now() - startTime;
                                pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>Total transactions: " + (firstData.numTxs || firstData.txs.length) + "<br/><br/>" + resultHTML;
                            } else { // turbo mode
                                resultHTML += "<h3>Request #1 (" + firstData.txs.length + " transactions):</h3>";
                                resultHTML += generateTxGrid(firstData.txs);
                                const totalTime = Date.now() - startTime;
                                pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>Total transactions: " + firstData.txs.length + "<br/><br/>" + resultHTML;
                            }
                        }
                    } catch (error) {
                        resultDiv.textContent = "Error: " + error.message;
                    }
                }

                async function nativeQuery() {
                    // Start timing
                    const startTime = Date.now();

                    const queryType = document.getElementById("queryType").value;
                    const queryInput = document.getElementById("queryInput").value;
                    const resultDiv = document.getElementById("result");

                    resultDiv.innerHTML = "";

                    try {
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

                        if (queryType === "block") {
                            // For block query, still use the /block endpoint (it already uses randomChronikClient)
                            const response = await fetch("/block/" + queryInput);
                            const data = await response.json();
                            const totalTime = Date.now() - startTime;
                            if (data.error) {
                                pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>Error: " + data.message;
                                pageContent.style.color = "#ff6b6b";
                            } else {
                                pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>" + safeStringify(data, 2);
                            }
                        } else {
                            // fixed pageSize 200, no turbo mode in native query
                            const pageSize = 200;
                            const queryParams = new URLSearchParams({
                                type: queryType,
                                input: queryInput,
                                pageSize: pageSize,
                                page: 0
                            });

                            const firstResponse = await fetch("/native?" + queryParams);
                            const firstData = await firstResponse.json();

                            // 添加错误处理
                            if (firstData.error) {
                                pageContent.innerHTML = "Error: " + firstData.error;
                                pageContent.style.color = "#ff6b6b";
                                return;
                            }

                            if (firstData.message) {
                                pageContent.innerHTML = "System message: " + firstData.message;
                                pageContent.style.color = "#ff6b6b";
                                return;
                            }

                            // 安全检查txs数组
                            if (!firstData.txs || !Array.isArray(firstData.txs)) {
                                pageContent.innerHTML = "Error: Invalid response format - missing or invalid txs array";
                                pageContent.style.color = "#ff6b6b";
                                return;
                            }

                            pageHeader.textContent = "Transactions (Total: " + (firstData.numTxs || firstData.txs.length) + ", Pages: " + (firstData.numPages || 1) + ")";

                            let resultHTML = "";
                            const totalPages = firstData.numPages || 1;
                            resultHTML += "<h3>Request #1 (" + firstData.txs.length + " transactions):</h3>";
                            resultHTML += generateTxGrid(firstData.txs);

                            for (let p = 1; p < totalPages; p++) {
                                const nextParams = new URLSearchParams({
                                    type: queryType,
                                    input: queryInput,
                                    pageSize: pageSize,
                                    page: p
                                });
                                const nextResponse = await fetch("/native?" + nextParams);
                                const nextData = await nextResponse.json();
                                
                                // 安全检查
                                if (nextData.txs && Array.isArray(nextData.txs)) {
                                    resultHTML += "<h3>Request #" + (p + 1) + " (" + nextData.txs.length + " transactions):</h3>";
                                    resultHTML += generateTxGrid(nextData.txs);
                                } else {
                                    resultHTML += "<h3>Request #" + (p + 1) + ": Error loading data</h3>";
                                }
                            }
                            const totalTime = Date.now() - startTime;
                            pageContent.innerHTML = "Elapsed time: " + totalTime + " ms<br/><br/>Total transactions: " + (firstData.numTxs || firstData.txs.length) + "<br/><br/>" + resultHTML;
                        }
                    } catch (error) {
                        resultDiv.textContent = "Error: " + error.message;
                    }
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

                    switch(e.target.value) {
                        case "address":
                            input.placeholder = "Enter eCash address...";
                            input.value = "ecash:qr6lws9uwmjkkaau4w956lugs9nlg9hudqs26lyxkv";
                            exampleNote.innerHTML = "Display latest 4000 transactions";
                            break;
                        case "p2pkh":
                            input.placeholder = "Enter Public Key Hash...";
                            input.value = "";
                            exampleNote.innerHTML = "Display latest 4000 transactions";
                            break;
                        case "p2sh":
                            input.placeholder = "Enter Script Hash...";
                            input.value = "";
                            exampleNote.innerHTML = "Display latest 4000 transactions";
                            break;
                        case "token":
                            input.placeholder = "Enter Token ID...";
                            input.value = "";
                            exampleNote.innerHTML = "Example Token ID: <code>7e7dacd72dcdb14e00a03dd3aff47f019ed51a6f1f4e4f532ae50692f62bc4dd</code>";
                            break;
                        case "block":
                            input.placeholder = "Enter block hash...";
                            input.value = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
                            exampleNote.innerHTML = "Example: Bitcoin Genesis block hash";
                            break;
                    }
                });
            </script>
        </body>
        </html>`);
});

// Query API endpoint
app.get("/query", async (req, res) => {
    try {
        const { type, input, page = 0, pageSize = 200, mode = "normal" } = req.query;
        
        if (!input) {
            return res.status(400).json({ error: "Input is required" });
        }

        // Set actual page size based on mode
        const actualPageSize = mode === "turbo" ? 8000 : 200;

        let result;
        if (type === "address") {
            result = await chronik.address(input).history(parseInt(page), actualPageSize);
        } else if (type === "p2pkh" || type === "p2sh") {
            result = await chronik.script(type, input).history(parseInt(page), actualPageSize);
        } else if (type === "token") {
            result = await chronik.tokenId(input).history(parseInt(page), actualPageSize);
        } else {
            return res.status(400).json({ error: "Unsupported query type" });
        }
        
        // 转换BigInt为字符串再返回
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
});

// Native Mode API endpoint (using randomChronikClient directly, no cache)
app.get("/native", async (req, res) => {
    try {
        const { type, input, page = 0 } = req.query;

        if (!input) {
            return res.status(400).json({ error: "Input is required" });
        }

        // Force page size to 200 in native mode
        const actualPageSize = 200;
        let result;
        if (type === "address") {
            result = await client.address(input).history(parseInt(page), actualPageSize);
        } else if (type === "p2pkh" || type === "p2sh") {
            result = await client.script(type, input).history(parseInt(page), actualPageSize);
        } else if (type === "token") {
            result = await client.tokenId(input).history(parseInt(page), actualPageSize);
        } else {
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
});

// Block API endpoint (uses single client)
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

// 添加新的统计数据路由
app.get('/stats', async (req, res) => {
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