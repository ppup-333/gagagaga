const express = require('express');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

// 記帳空間設定清單
const ROOMS = [
    {
        id: 'gaga',
        name: '嘎仔記帳本',
        password: 'gaga',
        members: ['忍', '凱', '果', '雷']
    }
];

app.use(express.json());
app.use(express.static('public'));

// 判斷是否有設定資料庫連線字串（例如 Render 上的 DATABASE_URL）
const hasDb = Boolean(process.env.DATABASE_URL);
let pool = null;

// 本地端無資料庫連線時的記憶體備用存儲（方便本機測試）
let memoryAccounts = [
    {
        id: '1',
        roomId: 'gaga',
        user: '忍',
        fromUser: '忍',
        toUser: '凱',
        amount: 350,
        note: '晚餐代墊',
        settled: false,
        time: '2026/11/3 上午11:30:00',
        createdAt: '2026-11-03T03:30:00.000Z'
    }
];
let memoryIdCounter = 2;

// 系統全域元資訊（刷新狀態等）
let systemMeta = {
    lastRefreshTime: null,
    lastRefreshedCount: 0
};

// 解析時間字串或 timestamp 為 Date 物件
function parseRecordDate(timeStr, createdAt) {
    if (createdAt) {
        const d = new Date(createdAt);
        if (!isNaN(d.getTime())) return d;
    }
    if (!timeStr || typeof timeStr !== 'string') return new Date();

    const direct = new Date(timeStr);
    if (!isNaN(direct.getTime())) return direct;

    const match = timeStr.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(上午|下午|AM|PM))?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/i);
    if (match) {
        let [_, y, m, d, period, h, min, s] = match;
        let year = parseInt(y, 10);
        let month = parseInt(m, 10) - 1;
        let day = parseInt(d, 10);
        let hour = parseInt(h, 10);
        let minute = parseInt(min || 0, 10);
        let second = parseInt(s || 0, 10);

        if (period === '下午' || (period && period.toUpperCase() === 'PM')) {
            if (hour < 12) hour += 12;
        } else if (period === '上午' || (period && period.toUpperCase() === 'AM')) {
            if (hour === 12) hour = 0;
        }
        const utc = Date.UTC(year, month, day, hour - 8, minute, second);
        return new Date(utc);
    }
    return new Date();
}

if (hasDb) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
}

// 初始化資料庫表格（若不存在則自動建立，並確保包含必要欄位）
async function initDB() {
    if (!pool) {
        console.log("未檢測到 DATABASE_URL，本地運行於記憶體模式。");
        return;
    }
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                room_id TEXT DEFAULT 'gaga',
                user_name TEXT NOT NULL,
                from_user TEXT,
                to_user TEXT,
                amount NUMERIC NOT NULL,
                note TEXT,
                settled BOOLEAN DEFAULT FALSE,
                time TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE accounts ADD COLUMN IF NOT EXISTS room_id TEXT DEFAULT 'gaga';
            ALTER TABLE accounts ADD COLUMN IF NOT EXISTS from_user TEXT;
            ALTER TABLE accounts ADD COLUMN IF NOT EXISTS to_user TEXT;
            ALTER TABLE accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

            CREATE TABLE IF NOT EXISTS system_meta (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log("PostgreSQL 資料庫與表格檢查/建立成功！");
    } catch (err) {
        console.error("資料庫初始化失敗：", err);
    }
}

// 資料刷新機制：在 30 天保留期限中，若資料年齡 >= 20 天（即 10 天內會被刪除），重建一筆完全相同資料取代原資料
async function checkAndRefreshExpiringAccounts() {
    const now = new Date();
    const nowStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const EXPIRY_THRESHOLD_DAYS = 20; // 30天保留期，>=20天表示會在 10 天內被刪除
    const MS_IN_DAY = 24 * 60 * 60 * 1000;
    let refreshedCount = 0;

    if (!pool) {
        // 記憶體模式
        for (let i = 0; i < memoryAccounts.length; i++) {
            const item = memoryAccounts[i];
            const recordDate = parseRecordDate(item.time, item.createdAt);
            const ageDays = (now.getTime() - recordDate.getTime()) / MS_IN_DAY;

            if (ageDays >= EXPIRY_THRESHOLD_DAYS) {
                // 重建一筆完全相同的資料取代原資料，保持顯示內容與排序不變
                memoryAccounts[i] = {
                    id: item.id,
                    roomId: item.roomId,
                    user: item.user,
                    fromUser: item.fromUser,
                    toUser: item.toUser,
                    amount: item.amount,
                    note: item.note,
                    settled: item.settled,
                    time: item.time, // 保持原始顯示時間字串
                    createdAt: now.toISOString() // 更新資料建立時間
                };
                refreshedCount++;
            }
        }
        systemMeta.lastRefreshTime = nowStr;
        systemMeta.lastRefreshedCount = refreshedCount;
        console.log(`[記憶體模式] 資料刷新檢查完成，共刷新 ${refreshedCount} 筆資料。`);
        return { refreshedCount, lastRefreshTime: nowStr };
    }

    // PostgreSQL 模式
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const res = await client.query('SELECT * FROM accounts ORDER BY id ASC');

        for (const row of res.rows) {
            const recordDate = parseRecordDate(row.time, row.created_at);
            const ageDays = (now.getTime() - recordDate.getTime()) / MS_IN_DAY;

            if (ageDays >= EXPIRY_THRESHOLD_DAYS) {
                // 刪除原資料並以相同 id 與內容重新建立，更新 created_at 為 NOW()
                await client.query('DELETE FROM accounts WHERE id = $1', [row.id]);
                await client.query(
                    `INSERT INTO accounts (id, room_id, user_name, from_user, to_user, amount, note, settled, time, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
                    [row.id, row.room_id, row.user_name, row.from_user, row.to_user, row.amount, row.note, row.settled, row.time]
                );
                refreshedCount++;
            }
        }

        // 確保序列 sequence 不會小於目前最大的 id
        await client.query(`
            SELECT setval(
                pg_get_serial_sequence('accounts', 'id'),
                COALESCE((SELECT MAX(id) FROM accounts), 1),
                true
            );
        `);

        // 記錄刷新時間至 system_meta
        await client.query(
            `INSERT INTO system_meta (key, value, updated_at)
             VALUES ('last_refresh_time', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [nowStr]
        );
        await client.query(
            `INSERT INTO system_meta (key, value, updated_at)
             VALUES ('last_refreshed_count', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [refreshedCount.toString()]
        );

        await client.query('COMMIT');
        systemMeta.lastRefreshTime = nowStr;
        systemMeta.lastRefreshedCount = refreshedCount;
        console.log(`[PostgreSQL] 資料刷新檢查完成，共重建取代 ${refreshedCount} 筆在 10 天內即將過期的資料。`);
        return { refreshedCount, lastRefreshTime: nowStr };
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('執行資料刷新機制失敗：', err);
        throw err;
    } finally {
        client.release();
    }
}

// 取得上一次刷新狀態
async function getLastRefreshStatus() {
    if (!pool) {
        return {
            lastRefreshTime: systemMeta.lastRefreshTime || '尚未記錄',
            lastRefreshedCount: systemMeta.lastRefreshedCount || 0
        };
    }
    try {
        const res = await pool.query("SELECT key, value FROM system_meta WHERE key IN ('last_refresh_time', 'last_refreshed_count')");
        let timeVal = systemMeta.lastRefreshTime;
        let countVal = systemMeta.lastRefreshedCount;
        for (const row of res.rows) {
            if (row.key === 'last_refresh_time') timeVal = row.value;
            if (row.key === 'last_refreshed_count') countVal = parseInt(row.value, 10);
        }
        return {
            lastRefreshTime: timeVal || '尚未記錄',
            lastRefreshedCount: countVal || 0
        };
    } catch (err) {
        console.error('讀取刷新狀態失敗：', err);
        return {
            lastRefreshTime: systemMeta.lastRefreshTime || '尚未記錄',
            lastRefreshedCount: systemMeta.lastRefreshedCount || 0
        };
    }
}

// 伺服器啟動時執行資料庫初始化與刷新檢查
initDB().then(async () => {
    console.log("正在執行伺服器啟動時的資料刷新檢查...");
    try {
        const res = await checkAndRefreshExpiringAccounts();
        console.log(`伺服器啟動刷新檢查完成：上一次刷新時間為 ${res.lastRefreshTime}，共刷新 ${res.refreshedCount} 筆。`);
    } catch (err) {
        console.error("伺服器啟動時資料刷新失敗：", err);
    }
});

// 1. 取得空間清單與成員 API（密碼不回傳給前端）
app.get('/api/rooms', (req, res) => {
    const safeRooms = ROOMS.map(r => ({
        id: r.id,
        name: r.name,
        members: r.members
    }));
    res.json(safeRooms);
});

// 2. 驗證密碼與登入 API（支援管理員密碼 iamadmin）
app.post('/api/login', (req, res) => {
    const { roomId, user, password } = req.body;
    const room = ROOMS.find(r => r.id === roomId);
    if (!room) {
        return res.status(400).json({ success: false, message: '找不到所選的記帳空間！' });
    }

    // 檢查是否為管理員密碼
    if (password === 'iamadmin') {
        return res.json({
            success: true,
            isAdmin: true,
            roomId: room.id,
            roomName: room.name,
            user: user || '管理員'
        });
    }

    // 一般成員密碼檢查
    if (password !== room.password) {
        return res.status(401).json({ success: false, message: '空間密碼錯誤！' });
    }
    if (!room.members.includes(user)) {
        return res.status(400).json({ success: false, message: '請選擇正確的成員！' });
    }

    res.json({
        success: true,
        isAdmin: false,
        roomId: room.id,
        roomName: room.name,
        user
    });
});

// 3. 登出 API
app.post('/api/logout', (req, res) => {
    res.json({ success: true, message: '已成功登出' });
});

// 4. 取得指定空間的帳目 API
app.get('/api/accounts', async (req, res) => {
    const roomId = req.query.roomId || 'gaga';
    if (!pool) {
        const filtered = memoryAccounts
            .filter(item => item.roomId === roomId)
            .sort((a, b) => Number(b.id) - Number(a.id));
        return res.json(filtered);
    }

    try {
        const result = await pool.query(
            'SELECT * FROM accounts WHERE room_id = $1 ORDER BY id DESC',
            [roomId]
        );
        const accounts = result.rows.map(row => ({
            id: row.id.toString(),
            roomId: row.room_id,
            user: row.user_name,
            fromUser: row.from_user || row.user_name,
            toUser: row.to_user || '',
            amount: Number(row.amount),
            note: row.note,
            settled: row.settled,
            time: row.time
        }));
        res.json(accounts);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '讀取資料失敗' });
    }
});

// 5. 新增一筆帳 API
app.post('/api/accounts', async (req, res) => {
    const { roomId = 'gaga', user, fromUser, toUser, amount, note } = req.body;
    const finalFrom = fromUser || user;
    const finalTo = toUser || '';

    if (!amount || !finalFrom) {
        return res.status(400).json({ success: false, message: '缺少必要欄位' });
    }

    // 檢查兩位成員至少有一位是登入者本人（管理員登入時除外）
    if (user !== '管理員' && finalFrom !== user && finalTo !== user) {
        return res.status(403).json({ success: false, message: '不可以幫別人記帳' });
    }

    // 項目為必填檢查
    if (!note || !note.trim()) {
        return res.status(400).json({ success: false, message: '項目為必填欄位！' });
    }
    
    const timeStr = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    if (!pool) {
        const newEntry = {
            id: (memoryIdCounter++).toString(),
            roomId,
            user,
            fromUser: finalFrom,
            toUser: finalTo,
            amount: Number(amount),
            note: note || '',
            settled: false,
            time: timeStr,
            createdAt: new Date().toISOString()
        };
        memoryAccounts.unshift(newEntry);
        return res.json({ success: true, data: newEntry });
    }

    try {
        const result = await pool.query(
            'INSERT INTO accounts (room_id, user_name, from_user, to_user, amount, note, settled, time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [roomId, user, finalFrom, finalTo, amount, note || '', false, timeStr]
        );
        const row = result.rows[0];
        const newEntry = {
            id: row.id.toString(),
            roomId: row.room_id,
            user: row.user_name,
            fromUser: row.from_user || row.user_name,
            toUser: row.to_user || '',
            amount: Number(row.amount),
            note: row.note,
            settled: row.settled,
            time: row.time
        };
        res.json({ success: true, data: newEntry });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '新增資料失敗' });
    }
});

// 6. 更新結清狀態 API（限制只有該筆帳目相關的兩位成員或管理員才可操作）
app.patch('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const { settled, currentUser, adminPassword } = req.body;
    const isAdmin = (adminPassword === 'iamadmin');

    if (!pool) {
        const target = memoryAccounts.find(item => item.id === id);
        if (!target) {
            return res.status(404).json({ success: false, message: '找不到該筆紀錄' });
        }
        const from = target.fromUser || target.user;
        const to = target.toUser;
        if (!isAdmin && currentUser && currentUser !== from && currentUser !== to) {
            return res.status(403).json({ 
                success: false, 
                message: `權限不足：只有相關的兩位成員（${from} 或 ${to}）才能變更結清狀態！` 
            });
        }
        target.settled = Boolean(settled);
        return res.json({ success: true });
    }

    try {
        const queryRes = await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
        if (queryRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: '找不到該筆紀錄' });
        }
        const row = queryRes.rows[0];
        const from = row.from_user || row.user_name;
        const to = row.to_user;
        if (!isAdmin && currentUser && currentUser !== from && currentUser !== to) {
            return res.status(403).json({ 
                success: false, 
                message: `權限不足：只有相關的兩位成員（${from} 或 ${to}）才能變更結清狀態！` 
            });
        }

        const result = await pool.query(
            'UPDATE accounts SET settled = $1 WHERE id = $2 RETURNING *',
            [settled, id]
        );
        if (result.rows.length > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: '找不到該筆紀錄' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '更新狀態失敗' });
    }
});

// 7. 管理員刪除帳目 API
app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const { adminPassword } = req.body;

    if (adminPassword !== 'iamadmin') {
        return res.status(403).json({ success: false, message: '權限不足：只有管理員才能刪除帳目！' });
    }

    if (!pool) {
        const index = memoryAccounts.findIndex(item => item.id === id);
        if (index !== -1) {
            memoryAccounts.splice(index, 1);
            return res.json({ success: true, message: '已成功刪除該筆帳目' });
        } else {
            return res.status(404).json({ success: false, message: '找不到該筆紀錄' });
        }
    }

    try {
        const result = await pool.query('DELETE FROM accounts WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length > 0) {
            res.json({ success: true, message: '已成功刪除該筆帳目' });
        } else {
            res.status(404).json({ success: false, message: '找不到該筆紀錄' });
        }
    } catch (err) {
        console.error('刪除帳目失敗：', err);
        res.status(500).json({ success: false, message: '刪除帳目失敗' });
    }
});

// 8. 取得上一次刷新狀態 API（管理員模式使用）
app.get('/api/admin/refresh-status', async (req, res) => {
    const adminPassword = req.query.adminPassword || req.headers['x-admin-password'];
    if (adminPassword !== 'iamadmin') {
        return res.status(403).json({ success: false, message: '權限不足：只有管理員才能檢視刷新狀態！' });
    }
    try {
        const status = await getLastRefreshStatus();
        res.json({ success: true, ...status });
    } catch (err) {
        res.status(500).json({ success: false, message: '讀取刷新狀態失敗' });
    }
});

// 9. 手動觸發資料刷新 API（管理員模式使用）
app.post('/api/admin/refresh', async (req, res) => {
    const { adminPassword } = req.body;
    if (adminPassword !== 'iamadmin') {
        return res.status(403).json({ success: false, message: '權限不足：只有管理員才能手動觸發資料刷新！' });
    }
    try {
        const result = await checkAndRefreshExpiringAccounts();
        res.json({
            success: true,
            lastRefreshTime: result.lastRefreshTime,
            refreshedCount: result.refreshedCount,
            message: `刷新機制執行成功！共檢測並重建取代 ${result.refreshedCount} 筆在 10 天內即將過期的資料。`
        });
    } catch (err) {
        console.error('手動觸發資料刷新失敗：', err);
        res.status(500).json({ success: false, message: '手動觸發資料刷新失敗' });
    }
});

app.listen(PORT, () => {
    console.log(`伺服器執行中：http://localhost:${PORT}`);
});
