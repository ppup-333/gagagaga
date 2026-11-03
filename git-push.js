const { execSync } = require('child_process');

function runCommand(command) {
    return execSync(command, { encoding: 'utf-8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
}

function main() {
    try {
        console.log('🔍 檢查 Git 狀態...');
        const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
        
        if (!status) {
            console.log('✨ 沒有任何異動需要提交。');
            return;
        }

        // 取得使用者傳入的 commit 訊息，若無則使用預設帶時間的訊息
        const userMessage = process.argv.slice(2).join(' ').trim();
        const now = new Date();
        const defaultTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        const commitMessage = userMessage || `Auto commit: ${defaultTime}`;

        console.log('📦 加入變更檔案 (git add .)...');
        execSync('git add -A', { stdio: 'inherit' });

        console.log(`📝 建立 Commit: "${commitMessage}"...`);
        execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });

        console.log('🚀 推送到遠端 (git push origin main)...');
        execSync('git push origin main', { stdio: 'inherit' });

        console.log('\n🎉 成功推送至 GitHub！');
    } catch (err) {
        console.error('\n❌ 執行過程中發生錯誤：');
        if (err.stderr) {
            console.error(err.stderr.toString());
        } else {
            console.error(err.message);
        }
        process.exit(1);
    }
}

main();
