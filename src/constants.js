// 缓存状态枚举
const CACHE_STATUS = {
    UNKNOWN: 'UNKNOWN',      // 未确认是否最新
    LATEST: 'LATEST',        // 最新
    UPDATING: 'UPDATING'     // 正在更新
};

// 默认配置常量
const DEFAULT_CONFIG = {
    MAX_MEMORY: 50000,           // 最大内存中可存储的交易数量
    MAX_CACHE_SIZE: 512,         // 默认最大缓存大小（MB）
    DEFAULT_PAGE_SIZE: 200,      // 默认分页大小
    CACHE_DIR: './.cache',       // 缓存目录
    WS_TIMEOUT: 43000000,         // 12 H WebSocket 初始超时时间（毫秒）
    WS_EXTEND_TIMEOUT: 1800000   // 30 M WebSocket 延长时间（毫秒）
};

module.exports = {
    CACHE_STATUS,
    DEFAULT_CONFIG
}; 