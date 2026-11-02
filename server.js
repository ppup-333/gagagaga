const express = require('express');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

// 全體一致的進場密碼 (你可以自行修改)
const ROOM_PASSWORD = "gaga"; 

app.use(express.json());
app.use(express.static('public'));

// 設定 PostgreSQL 連線 (會自動讀取 Render 的 DATABASE_URL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 初始化資料庫表格（若不存在則自動建立）
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                user_name TEXT NOT NULL,
                amount NUMERIC NOT NULL,
                note TEXT,
                settled BOOLEAN DEFAULT FALSE,
                time TEXT NOT NULL
            );
        `);
        console.log("資料庫與表格檢查/建立成功！");
    } catch (err) {
        console.error("資料庫初始化失敗：", err);
    }
}
initDB();

// 1. 驗證密碼 API
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ROOM_PASSWORD) {
        res.json({ success: true });
    } else {
        res.json({ success: false, message: '進場密碼錯誤！' });
    }
});

// 1.5 登出 API (新增)
app.post('/api/logout', (req, res) => {
    // 因為你是共用密碼登入，後端主要是回傳成功，主要動作在前端清除 localStorage/sessionStorage
    res.json({ success: true, message: '已成功登出' });
});

// 2. 取得所有帳目 API
app.get('/api/accounts', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM accounts ORDER BY id DESC');
        const accounts = result.rows.map(row => ({
            id: row.id.toString(),
            user: row.user_name,
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

// 3. 新增一筆帳 API
app.post('/api/accounts', async (req, res) => {
    const { user, amount, note } = req.body;
    if (!amount || !user) {
        return res.status(400).json({ success: false, message: '缺少必要欄位' });
    }
    
    const timeStr = new Date().toLocaleString();
    try {
        const result = await pool.query(
            'INSERT INTO accounts (user_name, amount, note, settled, time) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [user, amount, note || '', false, timeStr]
        );
        const row = result.rows[0];
        const newEntry = {
            id: row.id.toString(),
            user: row.user_name,
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

// 4. 更新結清狀態 API
app.patch('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const { settled } = req.body;
    
    try {
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

app.listen(PORT, () => {
    console.log(`伺服器執行中：http://localhost:${PORT}`);
});