// 缓存状态枚举
const CACHE_STATUS = {
    UNKNOWN: 'UNKNOWN',      // 未确认是否最新
    LATEST: 'LATEST',        // 最新
    UPDATING: 'UPDATING'     // 正在更新
};

// 默认配置常量
const DEFAULT_CONFIG = {
    MAX_MEMORY: 10000,
    MAX_CACHE_SIZE: 512,     // MB
    DEFAULT_PAGE_SIZE: 200,
    CACHE_DIR: './.cache'
};

module.exports = {
    CACHE_STATUS,
    DEFAULT_CONFIG
}; 