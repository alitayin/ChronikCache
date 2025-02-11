const CryptoJS = require("crypto-js");

// Compute the hash using key data.
// Only key data is passed to generate a consistent hash.
function computeHash(data) {
    const hash = CryptoJS.SHA256(JSON.stringify(data));
    return hash.toString(CryptoJS.enc.Hex);
}

module.exports = { computeHash }; 