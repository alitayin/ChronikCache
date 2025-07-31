// Copyright (c) 2024 The Bitcoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

import CryptoJS from 'crypto-js';

/**
 * Compute the hash using key data.
 * Only key data is passed to generate a consistent hash.
 */
export function computeHash(data: any): string {
    const hash = CryptoJS.SHA256(JSON.stringify(data));
    return hash.toString(CryptoJS.enc.Hex);
} 
