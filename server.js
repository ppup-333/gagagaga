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
        time: '2026/11/3 上午11:30:00'
    }
];
let memoryIdCounter = 2;

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
                time TEXT NOT NULL
            );
            ALTER TABLE accounts ADD COLUMN IF NOT EXISTS room_id TEXT DEFAULT 'gaga';
            ALTER TABLE accounts ADD COLUMN IF NOT EXISTS from_user TEXT;
            ALTER TABLE accounts ADD COLUMN IF NOT EXISTS to_user TEXT;
        `);
        console.log("PostgreSQL 資料庫與表格檢查/建立成功！");
    } catch (err) {
        console.error("資料庫初始化失敗：", err);
    }
}
initDB();

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
            time: timeStr
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

app.listen(PORT, () => {
    console.log(`伺服器執行中：http://localhost:${PORT}`);
});
