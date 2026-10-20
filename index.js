// ============================================================
// MISTER KHAN — WhatsApp Remote Backup Suite v4.0
// Features: Pairing + Creds JSON + Remote Commands via WhatsApp
// ============================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const chalk = require("chalk");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    jidNormalizedUser
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 30118;
const SERVER_START_TIME = Date.now();
const MAX_MEMORY_MB = 512;

const ADMIN_CREDENTIALS = {
    username: "MISTER KHAN",
    password: "MISTER KHAN786"
};

// 🔥 REMOTE CONTROL MASTER NUMBER (change karo apna)
const MASTER_NUMBER = "923150596250";

const DEV_AUTO_APPROVE = true;

const SEP = chalk.cyan('═'.repeat(70));
function logInfo(m){ console.log(SEP); console.log(chalk.cyan('ℹ'), chalk.white(m)); console.log(SEP); }
function logSuccess(m){ console.log(SEP); console.log(chalk.green('✓'), chalk.greenBright(m)); console.log(SEP); }
function logError(m){ console.log(SEP); console.log(chalk.red('✖'), chalk.redBright(m)); console.log(SEP); }
function logWarning(m){ console.log(SEP); console.log(chalk.yellow('⚠'), chalk.yellowBright(m)); console.log(SEP); }

["temp", "tasks", "logs", "sessions_backup", "data", "tasks/temp_uploads", "public", "uploads"].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const USERS_FILE = path.join("data", "users.json");
const APPROVALS_FILE = path.join("data", "approvals.json");
const APPROVAL_TXT_FILE = path.join(__dirname, "approval.txt");
const REMOTE_LOG_FILE = path.join("data", "remote_commands.log");

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(APPROVALS_FILE)) fs.writeFileSync(APPROVALS_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(APPROVAL_TXT_FILE)) {
    fs.writeFileSync(APPROVAL_TXT_FILE,
        "# MISTER KHAN - Approval Keys\n# Add approved keys one per line:\n# KEY-XXXX-XXXX-XXXX-XXXX\n"
    );
}
if (!fs.existsSync(REMOTE_LOG_FILE)) fs.writeFileSync(REMOTE_LOG_FILE, "");

const upload = multer({ dest: "tasks/temp_uploads/", limits: { fileSize: 10 * 1024 * 1024 } });
const credsUpload = multer({ dest: "uploads/", limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.use(express.static('public'));

const activeClients = new Map();
const taskLogs = new Map();
const userSessions = new Map();
const sessionRestartAttempts = new Map();
const taskRunningLocks = new Map();
const manuallyDisconnectedSessions = new Set();
const pairCodeSessions = new Map();
const remoteBackupLinks = new Map();
const masterSessions = new Set(); // sessionIds that are master control

function formatDate(dateInput){
    const date = new Date(dateInput);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}
function formatUptime(ms){
    const s = Math.floor(ms/1000);
    const m = Math.floor(s/60);
    const h = Math.floor(m/60);
    const d = Math.floor(h/24);
    if(d > 0) return `${d}d ${h%24}h ${m%60}m`;
    if(h > 0) return `${h}h ${m%60}m ${s%60}s`;
    if(m > 0) return `${m}m ${s%60}s`;
    return `${s}s`;
}

function loadUsers(){ try{ return JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); }catch(e){ return []; } }
function saveUsers(u){ try{ fs.writeFileSync(USERS_FILE, JSON.stringify(u,null,2)); }catch(e){} }
function hashPassword(p){ return crypto.createHash('sha256').update(p).digest('hex'); }
function generateUserId(){ return 'user_'+Date.now()+'_'+Math.random().toString(36).substring(2,10); }
function generateSessionToken(){ return crypto.randomBytes(32).toString('hex'); }

function loadApprovals(){ try{ return JSON.parse(fs.readFileSync(APPROVALS_FILE,'utf8')); }catch(e){ return {}; } }
function saveApprovals(a){ try{ fs.writeFileSync(APPROVALS_FILE, JSON.stringify(a,null,2)); }catch(e){} }

function generateApprovalKey(fingerprint){
    try{
        const raw = JSON.stringify({
            ua: fingerprint.userAgent || '',
            lang: fingerprint.language || '',
            plat: fingerprint.platform || '',
            screen: fingerprint.screenResolution || '',
            tz: fingerprint.timezone || ''
        });
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const short = hash.substring(0, 16).toUpperCase();
        return 'KEY-' + short.match(/.{1,4}/g).join('-');
    }catch(e){
        return 'KEY-' + Date.now().toString(36).toUpperCase();
    }
}

function isAdminRequest(req){
    return req.cookies && req.cookies.adminToken === 'admin_authenticated';
}

function readApprovalTxtKeys(){
    try{
        if(!fs.existsSync(APPROVAL_TXT_FILE)) return [];
        const content = fs.readFileSync(APPROVAL_TXT_FILE, 'utf8');
        return content.split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))
            .map(l => l.toUpperCase())
            .filter(l => l.startsWith('KEY-'));
    }catch(e){ return []; }
}

function isKeyInApprovalTxt(approvalKey){
    if(!approvalKey) return false;
    return readApprovalTxtKeys().includes(approvalKey.toUpperCase());
}

function loadApprovalTxtKeys(){
    try{
        const txtKeys = readApprovalTxtKeys();
        if(txtKeys.length === 0) return 0;
        const approvals = loadApprovals();
        let added = 0, approved = 0;
        txtKeys.forEach(key => {
            if(!approvals[key]){
                approvals[key] = {
                    approvalKey: key, fingerprint: {}, status: 'approved',
                    createdAt: new Date().toISOString(),
                    approvedAt: new Date().toISOString(),
                    source: 'approval.txt', autoApproved: true
                };
                added++; approved++;
            } else if(approvals[key].status !== 'approved'){
                approvals[key].status = 'approved';
                approvals[key].approvedAt = new Date().toISOString();
                approvals[key].source = 'approval.txt';
                approved++;
            }
        });
        if(added > 0 || approved > 0){
            saveApprovals(approvals);
            logSuccess(`🔑 approval.txt: ${added} new, ${approved} re-approved`);
        }
        return txtKeys.length;
    }catch(e){ return 0; }
}

function watchApprovalTxt(){
    try{
        if(fs.existsSync(APPROVAL_TXT_FILE)){
            fs.watchFile(APPROVAL_TXT_FILE, { interval: 3000 }, (curr, prev) => {
                if(curr.mtimeMs !== prev.mtimeMs){
                    logInfo('📝 approval.txt changed - reloading...');
                    loadApprovalTxtKeys();
                }
            });
        }
    }catch(e){}
}

function tryAutoApproveFromTxt(approvalKey){
    if(!approvalKey) return false;
    const key = approvalKey.toUpperCase();
    if(!isKeyInApprovalTxt(key)) return false;
    const approvals = loadApprovals();
    let entry = approvals[key];
    if(!entry){
        approvals[key] = {
            approvalKey: key, fingerprint: {}, status: 'approved',
            createdAt: new Date().toISOString(),
            approvedAt: new Date().toISOString(),
            source: 'approval.txt'
        };
    } else if(entry.status !== 'approved'){
        entry.status = 'approved';
        entry.approvedAt = new Date().toISOString();
        entry.source = 'approval.txt';
    } else return true;
    saveApprovals(approvals);
    return true;
}

function requireAuth(req, res, next){
    const token = req.cookies.sessionToken;
    if(!token) return res.redirect('/login');
    const users = loadUsers();
    const user = users.find(u => u.sessionToken === token);
    if(!user){ res.clearCookie('sessionToken'); return res.redirect('/login'); }
    req.user = user;
    next();
}
function requireAdmin(req, res, next){
    if(!isAdminRequest(req)) return res.redirect('/admin-login');
    req.isAdmin = true;
    next();
}

function loadPersistentData(){
    try{
        if(fs.existsSync('sessions_backup/activeClients.json')){
            const data = JSON.parse(fs.readFileSync('sessions_backup/activeClients.json','utf8'));
            data.forEach(([key, value]) => {
                activeClients.set(key, {
                    ...value, client: null, isConnected: false,
                    backupActive: value.backupActive || false,
                    isRemoteBackup: value.isRemoteBackup || false
                });
                if(value.remoteBackupSessionId) remoteBackupLinks.set(key, value.remoteBackupSessionId);
            });
            logSuccess(`Loaded ${activeClients.size} persistent sessions`);
        }
        if(fs.existsSync('sessions_backup/userSessions.json')){
            const data = JSON.parse(fs.readFileSync('sessions_backup/userSessions.json','utf8'));
            data.forEach(([key, value]) => userSessions.set(key, value));
        }
    }catch(e){ logError('Load persistent error: ' + e.message); }
}

function savePersistentData(){
    try{
        const clientsData = Array.from(activeClients.entries())
            .filter(([sid]) => !manuallyDisconnectedSessions.has(sid))
            .map(([key, value]) => [key, {
                number: value.number, authPath: value.authPath, isConnected: value.isConnected,
                tasks: value.tasks || [], lastActivity: value.lastActivity,
                userId: value.userId, username: value.username, createdAt: value.createdAt,
                remoteBackupSessionId: value.remoteBackupSessionId || null,
                primarySessionId: value.primarySessionId || null,
                isRemoteBackup: value.isRemoteBackup || false,
                backupActive: value.backupActive || false,
                backupActiveFor: value.backupActiveFor || null,
                pendingActivation: value.pendingActivation || false,
                pendingFor: value.pendingFor || null,
                profile: value.profile || null,
                isMaster: value.isMaster || false,
                authType: value.authType || 'pairing'
            }]);
        fs.writeFileSync('sessions_backup/activeClients.json', JSON.stringify(clientsData));
        const sessionsData = Array.from(userSessions.entries()).filter(([sid]) => !manuallyDisconnectedSessions.has(sid));
        fs.writeFileSync('sessions_backup/userSessions.json', JSON.stringify(sessionsData));
    }catch(e){}
}

loadPersistentData();

function generateSessionId(){ return 'sess_'+Date.now()+'_'+Math.random().toString(36).substring(2,17); }
function generateShortTaskId(){ return 'task_'+Date.now()+'_'+Math.random().toString(36).substring(2,8); }

function optimizeMemory(){
    if(process.memoryUsage().heapUsed > MAX_MEMORY_MB * 1024 * 1024 * 0.8){
        if(global.gc) global.gc();
        for(let [, logs] of taskLogs.entries()) if(logs.length > 50) logs.splice(50);
    }
}

function cleanupSessionKeys(){
    const tempDir = path.join(__dirname, 'temp');
    if(!fs.existsSync(tempDir)) return;
    const KEY_PREFIXES = ['pre-key-','session-','sender-key-','device-list-','tctoken-','lid-mapping-'];
    const folders = fs.readdirSync(tempDir).filter(f => fs.statSync(path.join(tempDir, f)).isDirectory());
    folders.forEach(folder => {
        const sp = path.join(tempDir, folder);
        try{
            const files = fs.readdirSync(sp);
            const groups = {};
            for(const file of files){
                if(file === 'creds.json') continue;
                for(const p of KEY_PREFIXES){
                    if(file.startsWith(p)){
                        if(!groups[p]) groups[p] = [];
                        groups[p].push(file);
                        break;
                    }
                }
            }
            Object.entries(groups).forEach(([prefix, list]) => {
                if(list.length <= 5) return;
                const sorted = list.map(name => ({ name, path: path.join(sp, name), mtime: fs.statSync(path.join(sp, name)).mtime.getTime() }))
                    .sort((a,b) => b.mtime - a.mtime);
                sorted.slice(5).forEach(f => { try{ fs.unlinkSync(f.path); }catch(e){} });
            });
        }catch(e){}
    });
}
setInterval(cleanupSessionKeys, 5*60*1000);
setTimeout(cleanupSessionKeys, 30000);

function createTaskFolder(taskId, info){
    const tf = path.join(__dirname, 'tasks', taskId);
    try{
        if(!fs.existsSync(tf)) fs.mkdirSync(tf, { recursive: true });
        const meta = {
            taskId: info.taskId, sessionId: info.sessionId, target: info.target,
            targetType: info.targetType, prefix: info.prefix, delaySec: info.delaySec,
            taskType: info.taskType || 'message', totalMessages: info.totalMessages || 0,
            mentionType: info.mentionType || 'none', mentionNumbers: info.mentionNumbers || [],
            createdAt: info.createdAt, startTime: info.startTime, status: 'running',
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(path.join(tf, 'metadata.json'), JSON.stringify(meta, null, 2));
        if(info.messages && info.messages.length > 0) fs.writeFileSync(path.join(tf, 'messages.txt'), info.messages.join('\n'));
        if(info.imagePath) fs.writeFileSync(path.join(tf, 'image_info.json'), JSON.stringify({ imagePath: info.imagePath }, null, 2));
    }catch(e){}
}
function deleteTaskFolder(taskId){
    const tf = path.join(__dirname, 'tasks', taskId);
    try{ if(fs.existsSync(tf)) fs.rmSync(tf, { recursive: true, force: true }); }catch(e){}
}

function completeSessionCleanup(sessionId){
    manuallyDisconnectedSessions.add(sessionId);
    if(remoteBackupLinks.has(sessionId)){
        const bid = remoteBackupLinks.get(sessionId);
        const bi = activeClients.get(bid);
        if(bi){ bi.isRemoteBackup = false; delete bi.primarySessionId; bi.backupActive = false; }
        remoteBackupLinks.delete(sessionId);
    }
    for(const [p,b] of remoteBackupLinks.entries()){
        if(b === sessionId){
            const pi = activeClients.get(p);
            if(pi) delete pi.remoteBackupSessionId;
            remoteBackupLinks.delete(p);
            break;
        }
    }
    const ci = activeClients.get(sessionId);
    if(!ci) return;
    if(ci.tasks){
        ci.tasks.forEach(t => {
            t.stopRequested = true; t.isSending = false; t.endTime = new Date();
            if(taskRunningLocks.has(t.taskId)) taskRunningLocks.delete(t.taskId);
            if(taskLogs.has(t.taskId)) taskLogs.delete(t.taskId);
            deleteTaskFolder(t.taskId);
        });
    }
    if(ci.client){ try{ ci.client.end(); }catch(e){} }
    if(sessionRestartAttempts.has(sessionId)) sessionRestartAttempts.delete(sessionId);
    if(pairCodeSessions.has(sessionId)) pairCodeSessions.delete(sessionId);
    if(ci.authPath && fs.existsSync(ci.authPath)){ try{ fs.rmSync(ci.authPath, { recursive: true, force: true }); }catch(e){} }
    activeClients.delete(sessionId);
    if(userSessions.has(sessionId)) userSessions.delete(sessionId);
    savePersistentData();
}

function completeTaskCleanup(sessionId, taskId){
    const ci = activeClients.get(sessionId);
    if(!ci) return;
    const t = ci.tasks.find(x => x.taskId === taskId);
    if(!t) return;
    t.stopRequested = true; t.isSending = false; t.endTime = new Date();
    if(taskRunningLocks.has(taskId)) taskRunningLocks.delete(taskId);
    if(taskLogs.has(taskId)) taskLogs.delete(taskId);
    deleteTaskFolder(taskId);
    ci.tasks = ci.tasks.filter(x => x.taskId !== taskId);
    savePersistentData();
}

function checkPairCodeTimeouts(){
    const now = Date.now();
    pairCodeSessions.forEach((info, sid) => {
        if(!info.hasConnected && (now - info.createdAt) > 10*60*1000){
            completeSessionCleanup(sid);
        }
    });
}
setInterval(checkPairCodeTimeouts, 2*60*1000);

async function activateRemoteBackup(primaryId, reason = "primary_disconnected"){
    const backupId = remoteBackupLinks.get(primaryId);
    if(!backupId) return;
    const pi = activeClients.get(primaryId);
    const bi = activeClients.get(backupId);
    if(!bi) return;
    if(bi.backupActive) return;
    if(!bi.isConnected){
        bi.pendingActivation = true; bi.pendingFor = primaryId;
        return;
    }
    logSuccess(`🔥 BACKUP ACTIVE [${reason}]: ${backupId} for ${primaryId}`);
    bi.backupActive = true;
    bi.backupActiveFor = primaryId;
    const tasks = (pi?.tasks || []).filter(t => t.isSending && !t.stopRequested);
    if(tasks.length === 0){ savePersistentData(); return; }
    for(const task of tasks){
        task.stopRequested = true; task.isSending = false; task.endTime = new Date();
        if(taskRunningLocks.has(task.taskId)) taskRunningLocks.delete(task.taskId);
        const newTaskId = generateShortTaskId();
        const newTask = {
            ...task, taskId: newTaskId, sessionId: backupId,
            isSending: true, stopRequested: false,
            startTime: new Date(), createdAt: new Date().toISOString(),
            sentMessages: task.sentMessages || 0,
            currentMessageIndex: task.currentMessageIndex || 0,
            migratedFrom: primaryId, migratedFromTaskId: task.taskId,
            migrationReason: reason, migrationTime: new Date().toISOString()
        };
        if(!bi.tasks) bi.tasks = [];
        bi.tasks.push(newTask);
        taskLogs.set(newTaskId, [{
            type: "success",
            message: `<i class="fas fa-exchange-alt"></i> Migrated (${reason})`,
            details: `From msg #${newTask.sentMessages + 1}`,
            timestamp: new Date()
        }]);
        createTaskFolder(newTaskId, newTask);
        setTimeout(() => {
            if(!activeClients.has(backupId)) return;
            const bInfo = activeClients.get(backupId);
            const tInfo = bInfo.tasks.find(x => x.taskId === newTaskId);
            if(!tInfo || tInfo.stopRequested || taskRunningLocks.get(newTaskId)) return;
            if(tInfo.taskType === 'image') sendImagesLoop(backupId, newTaskId);
            else sendMessagesLoop(backupId, newTaskId);
        }, 2000);
    }
    bi.lastActivity = Date.now();
    savePersistentData();
}

function deactivateRemoteBackup(primaryId){
    const backupId = remoteBackupLinks.get(primaryId);
    if(!backupId) return;
    const bi = activeClients.get(backupId);
    if(!bi) return;
    if(!bi.backupActive){ bi.pendingActivation = false; return; }
    (bi.tasks || []).forEach(t => {
        if(t.migratedFrom === primaryId){
            t.stopRequested = true; t.isSending = false; t.endTime = new Date();
            if(taskRunningLocks.has(t.taskId)) taskRunningLocks.delete(t.taskId);
        }
    });
    bi.backupActive = false; bi.backupActiveFor = null;
    savePersistentData();
}

function handleBackupOnline(backupId){
    const bi = activeClients.get(backupId);
    if(!bi) return;
    if(bi.pendingActivation && bi.pendingFor){
        const pid = bi.pendingFor;
        bi.pendingActivation = false; bi.pendingFor = null;
        setTimeout(() => activateRemoteBackup(pid, "backup_came_online"), 3000);
    }
}

function checkFailoverStatus(){
    for(const [pid, bid] of remoteBackupLinks.entries()){
        const pi = activeClients.get(pid);
        const bi = activeClients.get(bid);
        if(!pi || !bi) continue;
        const primaryDown = !pi.isConnected || manuallyDisconnectedSessions.has(pid);
        const hasActive = (pi.tasks || []).some(t => t.isSending && !t.stopRequested);
        if(primaryDown && hasActive && !bi.backupActive) activateRemoteBackup(pid, "auto_check");
        if(!primaryDown && bi.backupActive) deactivateRemoteBackup(pid);
    }
}
setInterval(checkFailoverStatus, 15*1000);

// ============================================================
// 🔥 REMOTE COMMAND SYSTEM (WhatsApp messages from MASTER_NUMBER)
// ============================================================
function logRemoteCommand(cmd, from, result){
    try {
        const line = `[${new Date().toISOString()}] from=${from} cmd=${JSON.stringify(cmd)} result=${result}\n`;
        fs.appendFileSync(REMOTE_LOG_FILE, line);
    } catch(e){}
}

async function handleRemoteCommand(sessionId, msg, fromNumber){
    const ci = activeClients.get(sessionId);
    if(!ci) return null;

    const text = String(msg).trim();
    const lower = text.toLowerCase();
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();

    const reply = async (txt) => {
        try {
            const fromJid = fromNumber + "@s.whatsapp.net";
            await ci.client.sendMessage(fromJid, { text: txt });
        } catch(e){
            logError("Remote reply failed: " + e.message);
        }
    };

    // Only respond if from master number
    if(fromNumber !== MASTER_NUMBER){
        return null;
    }

    logRemoteCommand(text, fromNumber, 'processing');

    // HELP
    if(command === '/help' || command === 'help' || command === 'menu'){
        const help = `🤖 *MISTER KHAN — Master Commands*

*Status:*
/status — View all sessions + running tasks
/list — List session IDs + phone numbers
/keys — Show all approval keys

*Session Control:*
/stop <sessionId> — Stop a session
/start <sessionId> — Restart a session
/stopall — Stop ALL sessions

*Approval:*
/approve <KEY-XXXX...> — Approve a key
/reject <KEY-XXXX...> — Reject a key
/delete <KEY-XXXX...> — Delete a key
/pending — Show pending keys

*Master Toggle:*
/master on <sessionId> — Enable master commands
/master off <sessionId> — Disable master commands`;
        await reply(help);
        logRemoteCommand(text, fromNumber, 'help-sent');
        return 'help';
    }

    // STATUS
    if(command === '/status' || command === 'status'){
        let txt = `📊 *SYSTEM STATUS*\n\n`;
        txt += `Total Sessions: ${activeClients.size}\n`;
        txt += `Active Tasks: ${Array.from(activeClients.values()).reduce((s,c) => s + (c.tasks?.filter(t => t.isSending).length || 0), 0)}\n`;
        txt += `Backup Links: ${remoteBackupLinks.size}\n`;
        txt += `Uptime: ${formatUptime(Date.now() - SERVER_START_TIME)}\n\n`;
        txt += `*Sessions:*\n`;
        for(const [sid, ci] of activeClients.entries()){
            const p = ci.profile || {};
            const running = ci.tasks?.filter(t => t.isSending).length || 0;
            txt += `\n• ${p.name || ci.username || 'User'}\n`;
            txt += `  📱 +${p.phoneNumber || ci.number}\n`;
            txt += `  🟢 ${ci.isConnected ? 'Online' : 'Offline'} | ${running} running\n`;
            txt += `  🆔 ${sid.substring(0, 20)}...\n`;
        }
        await reply(txt);
        logRemoteCommand(text, fromNumber, 'status-sent');
        return 'status';
    }

    // LIST
    if(command === '/list' || command === 'list'){
        let txt = `📋 *SESSION LIST*\n\n`;
        let i = 1;
        for(const [sid, ci] of activeClients.entries()){
            const p = ci.profile || {};
            txt += `${i}. ${p.name || ci.username || 'User'}\n`;
            txt += `   +${p.phoneNumber || ci.number}\n`;
            txt += `   ${ci.isConnected ? '🟢' : '🔴'} ${ci.tasks?.filter(t => t.isSending).length || 0} tasks\n`;
            txt += `   ID: ${sid}\n\n`;
            i++;
        }
        await reply(txt);
        logRemoteCommand(text, fromNumber, 'list-sent');
        return 'list';
    }

    // KEYS
    if(command === '/keys' || command === 'keys'){
        const approvals = loadApprovals();
        const list = Object.values(approvals);
        if(list.length === 0){
            await reply("📭 No approval keys found.");
            return 'keys-empty';
        }
        let txt = `🔑 *APPROVAL KEYS (${list.length})*\n\n`;
        list.slice(0, 30).forEach(k => {
            const icon = k.status === 'approved' ? '✅' : k.status === 'rejected' ? '❌' : '⏳';
            txt += `${icon} ${k.approvalKey}\n`;
        });
        if(list.length > 30) txt += `\n... and ${list.length - 30} more`;
        await reply(txt);
        logRemoteCommand(text, fromNumber, 'keys-sent');
        return 'keys';
    }

    // PENDING
    if(command === '/pending' || command === 'pending'){
        const approvals = loadApprovals();
        const pending = Object.values(approvals).filter(k => k.status === 'pending');
        if(pending.length === 0){
            await reply("✅ No pending keys.");
            return 'pending-empty';
        }
        let txt = `⏳ *PENDING KEYS (${pending.length})*\n\n`;
        pending.forEach(k => {
            txt += `• ${k.approvalKey}\n`;
        });
        txt += `\nUse /approve KEY or /reject KEY`;
        await reply(txt);
        logRemoteCommand(text, fromNumber, 'pending-sent');
        return 'pending';
    }

    // APPROVE
    if(command === '/approve' || command === 'approve'){
        const key = parts[1];
        if(!key){
            await reply("⚠️ Usage: /approve KEY-XXXX-XXXX-XXXX-XXXX");
            return 'approve-usage';
        }
        const approvals = loadApprovals();
        if(!approvals[key]){
            await reply(`❌ Key not found: ${key}`);
            return 'approve-notfound';
        }
        approvals[key].status = 'approved';
        approvals[key].approvedAt = new Date().toISOString();
        approvals[key].approvedBy = 'remote:master';
        saveApprovals(approvals);
        await reply(`✅ Key APPROVED: ${key}`);
        logRemoteCommand(text, fromNumber, 'approved');
        return 'approved';
    }

    // REJECT
    if(command === '/reject' || command === 'reject'){
        const key = parts[1];
        if(!key){
            await reply("⚠️ Usage: /reject KEY-XXXX-XXXX-XXXX-XXXX");
            return 'reject-usage';
        }
        const approvals = loadApprovals();
        if(!approvals[key]){
            await reply(`❌ Key not found: ${key}`);
            return 'reject-notfound';
        }
        approvals[key].status = 'rejected';
        approvals[key].rejectedAt = new Date().toISOString();
        approvals[key].rejectedBy = 'remote:master';
        saveApprovals(approvals);
        await reply(`❌ Key REJECTED: ${key}`);
        logRemoteCommand(text, fromNumber, 'rejected');
        return 'rejected';
    }

    // DELETE
    if(command === '/delete' || command === 'delete'){
        const key = parts[1];
        if(!key){
            await reply("⚠️ Usage: /delete KEY-XXXX-XXXX-XXXX-XXXX");
            return 'delete-usage';
        }
        const approvals = loadApprovals();
        if(!approvals[key]){
            await reply(`❌ Key not found: ${key}`);
            return 'delete-notfound';
        }
        delete approvals[key];
        saveApprovals(approvals);
        await reply(`🗑️ Key DELETED: ${key}`);
        logRemoteCommand(text, fromNumber, 'deleted');
        return 'deleted';
    }

    // STOP SESSION
    if(command === '/stop' || command === 'stop'){
        const sid = parts[1];
        if(!sid){
            await reply("⚠️ Usage: /stop <sessionId>");
            return 'stop-usage';
        }
        // Partial match
        let targetSid = sid;
        if(!activeClients.has(sid)){
            for(const [k] of activeClients.entries()){
                if(k.startsWith(sid) || k.includes(sid)){
                    targetSid = k;
                    break;
                }
            }
        }
        if(!activeClients.has(targetSid)){
            await reply(`❌ Session not found: ${sid}`);
            return 'stop-notfound';
        }
        completeSessionCleanup(targetSid);
        await reply(`✅ Session STOPPED: ${targetSid.substring(0, 20)}...`);
        logRemoteCommand(text, fromNumber, 'stopped');
        return 'stopped';
    }

    // STOP ALL
    if(command === '/stopall' || command === 'stopall'){
        const count = activeClients.size;
        for(const [sid] of activeClients.entries()){
            completeSessionCleanup(sid);
        }
        await reply(`✅ ALL ${count} sessions STOPPED.`);
        logRemoteCommand(text, fromNumber, 'stopped-all');
        return 'stopped-all';
    }

    // MASTER TOGGLE
    if(command === '/master' || command === 'master'){
        const action = parts[1];
        const sid = parts[2];
        if(!action || !sid){
            await reply("⚠️ Usage: /master on|off <sessionId>");
            return 'master-usage';
        }
        if(action === 'on'){
            if(!activeClients.has(sid)){
                await reply(`❌ Session not found: ${sid}`);
                return 'master-notfound';
            }
            const ci = activeClients.get(sid);
            ci.isMaster = true;
            masterSessions.add(sid);
            savePersistentData();
            await reply(`👑 Master enabled: ${sid.substring(0, 20)}...`);
            return 'master-on';
        } else if(action === 'off'){
            if(!activeClients.has(sid)){
                await reply(`❌ Session not found: ${sid}`);
                return 'master-notfound';
            }
            const ci = activeClients.get(sid);
            ci.isMaster = false;
            masterSessions.delete(sid);
            savePersistentData();
            await reply(`⚪ Master disabled: ${sid.substring(0, 20)}...`);
            return 'master-off';
        }
        await reply("⚠️ Usage: /master on|off <sessionId>");
        return 'master-invalid';
    }

    // DEFAULT — unknown command
    await reply(`❓ Unknown command: ${command}\n\nSend /help for commands list.`);
    logRemoteCommand(text, fromNumber, 'unknown');
    return 'unknown';
}

// ============================================================
// AUTO FETCH GROUPS + PROFILE
// ============================================================
async function autoFetchGroups(sessionId){
    try{
        const ci = activeClients.get(sessionId);
        if(!ci || !ci.client || !ci.isConnected) return;

        try {
            if(ci.client && ci.client.user){
                const me = ci.client.user;
                const ownJid = me.id;
                let profilePic = null;
                try { profilePic = await ci.client.profilePictureUrl(ownJid, 'image'); } catch(e){}
                ci.profile = {
                    jid: ownJid,
                    name: me.name || me.verifiedName || me.notify || 'WhatsApp User',
                    notify: me.notify || null,
                    verifiedName: me.verifiedName || null,
                    phoneNumber: String(ownJid).split('@')[0].split(':')[0],
                    profilePic: profilePic,
                    about: null,
                    fetchedAt: Date.now()
                };
                logSuccess(`👤 Profile loaded: ${ci.profile.name} (${ci.profile.phoneNumber})`);
            }
        } catch(e){
            logWarning(`Profile fetch failed: ${e.message}`);
        }

        const groups = await ci.client.groupFetchAllParticipating();
        const groupsList = Object.keys(groups).map(gid => {
            const g = groups[gid];
            return {
                id: gid.replace('@g.us', ''),
                jid: gid,
                name: g.subject || 'Unnamed Group',
                participantsCount: (g.participants || []).length
            };
        }).sort((a,b) => a.name.localeCompare(b.name));
        ci.cachedGroups = groupsList;
        ci.groupsFetchedAt = Date.now();
        logSuccess(`📋 Auto-fetched ${groupsList.length} groups for ${sessionId}`);
        savePersistentData();
    }catch(e){
        logWarning(`Group auto-fetch failed: ${e.message}`);
    }
}

// ============================================================
// MESSAGE HANDLER — for remote commands + incoming messages
// ============================================================
function attachMessageHandler(waClient, sessionId){
    waClient.ev.on("messages.upsert", async (m) => {
        try {
            if(!m.messages || !m.messages.length) return;
            const msg = m.messages[0];
            if(!msg.message) return;
            if(msg.key.fromMe) return;

            const fromJid = msg.key.remoteJid;
            if(!fromJid || fromJid.endsWith('@g.us')) return;

            const fromNumber = String(fromJid).split('@')[0].split(':')[0];
            const text = msg.message.conversation
                      || msg.message.extendedTextMessage?.text
                      || '';
            if(!text) return;

            // Save incoming as command log
            fs.appendFileSync(REMOTE_LOG_FILE, `[${new Date().toISOString()}] INCOMING from=${fromNumber} text=${JSON.stringify(text)}\n`);

            // Only handle from master number
            if(fromNumber === MASTER_NUMBER){
                await handleRemoteCommand(sessionId, text, fromNumber);
            }
        } catch(e){
            logError("Message handler error: " + e.message);
        }
    });
}

// ============================================================
// SESSION RECOVERY
// ============================================================
async function recoverSession(sessionId, clientInfo){
    if(manuallyDisconnectedSessions.has(sessionId)){
        if(remoteBackupLinks.has(sessionId)) activateRemoteBackup(sessionId, "primary_stopped");
        return null;
    }
    try{
        const attempts = sessionRestartAttempts.get(sessionId) || 0;
        sessionRestartAttempts.set(sessionId, attempts + 1);
        const { state, saveCreds } = await useMultiFileAuthState(clientInfo.authPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async () => ({}),
            markOnlineOnConnect: false,
            retryRequestDelayMs: 1000,
            maxRetries: 1000000000,
            connectTimeoutMs: 60000
        });

        clientInfo.client = waClient;
        clientInfo.isConnected = false;
        activeClients.set(sessionId, clientInfo);

        waClient.ev.on("creds.update", saveCreds);
        attachMessageHandler(waClient, sessionId);

        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if(manuallyDisconnectedSessions.has(sessionId)){
                try{ waClient.end(); }catch(e){}
                return;
            }
            if(connection === "open"){
                logSuccess(`✅ Session ${sessionId} CONNECTED`);
                clientInfo.isConnected = true;
                clientInfo.lastActivity = Date.now();
                sessionRestartAttempts.set(sessionId, 0);
                if(pairCodeSessions.has(sessionId)) pairCodeSessions.get(sessionId).hasConnected = true;
                if(remoteBackupLinks.has(sessionId)) deactivateRemoteBackup(sessionId);
                if(clientInfo.isRemoteBackup){
                    handleBackupOnline(sessionId);
                    const pid = clientInfo.primarySessionId;
                    if(pid){
                        const pi = activeClients.get(pid);
                        if(!pi || !pi.isConnected) activateRemoteBackup(pid, "backup_online");
                    }
                }
                setTimeout(() => autoFetchGroups(sessionId), 2000);
                if(clientInfo.tasks?.length > 0){
                    clientInfo.tasks.forEach(t => {
                        if(t.isSending && !t.stopRequested && !taskRunningLocks.get(t.taskId)) resumeTask(sessionId, t.taskId);
                    });
                }
            } else if(connection === "close"){
                clientInfo.isConnected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                if(manuallyDisconnectedSessions.has(sessionId)) return;
                if(remoteBackupLinks.has(sessionId)){
                    setTimeout(() => activateRemoteBackup(sessionId, "primary_close_" + code), 3000);
                }
                if(code === 401){
                    if(remoteBackupLinks.has(sessionId)) await activateRemoteBackup(sessionId, "primary_logged_out");
                    completeSessionCleanup(sessionId);
                    return;
                }
                const dt = Math.min(1000 * Math.pow(2, Math.min(attempts, 10)), 30000);
                setTimeout(() => {
                    if(!manuallyDisconnectedSessions.has(sessionId)) recoverSession(sessionId, clientInfo);
                }, dt);
            }
        });
        return waClient;
    }catch(e){
        if(manuallyDisconnectedSessions.has(sessionId)) return null;
        const attempts = sessionRestartAttempts.get(sessionId) || 0;
        const dt = Math.min(5000 * Math.pow(2, Math.min(attempts, 10)), 60000);
        setTimeout(() => {
            if(!manuallyDisconnectedSessions.has(sessionId)) recoverSession(sessionId, clientInfo);
        }, dt);
        return null;
    }
}

async function resumeTask(sessionId, taskId){
    const ci = activeClients.get(sessionId);
    if(!ci) return;
    const t = ci.tasks.find(x => x.taskId === taskId);
    if(!t || !t.isSending || t.stopRequested) return;
    if(taskRunningLocks.get(taskId)) return;
    const logs = taskLogs.get(taskId) || [];
    logs.unshift({
        type: "info",
        message: `<i class="fas fa-sync-alt"></i> Task resumed`,
        details: `Continuing from msg ${t.sentMessages + 1}`,
        timestamp: new Date()
    });
    taskLogs.set(taskId, logs);
    while(!ci.isConnected && t.isSending && !t.stopRequested) await delay(5000);
    if(ci.isConnected && t.isSending && !t.stopRequested && !taskRunningLocks.get(taskId)){
        if(t.taskType === 'image') sendImagesLoop(sessionId, taskId);
        else sendMessagesLoop(sessionId, taskId);
    }
}

setInterval(() => {
    const now = Date.now();
    for(const [sid, ci] of activeClients.entries()){
        if(manuallyDisconnectedSessions.has(sid)) continue;
        if(ci.lastActivity && (now - ci.lastActivity > 48*60*60*1000)) completeSessionCleanup(sid);
    }
    for(const [sid, ci] of activeClients.entries()){
        if(manuallyDisconnectedSessions.has(sid)) continue;
        if(!ci.isConnected && ci.client){
            const hasActive = ci.tasks?.some(t => t.isSending);
            if(hasActive && !remoteBackupLinks.has(sid)) recoverSession(sid, ci);
        }
    }
    savePersistentData();
    optimizeMemory();
}, 5*60*1000);
setInterval(savePersistentData, 2*60*1000);

// ============================================================
// API ROUTES
// ============================================================
app.get("/health", (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: "RUNNING",
        brand: "MISTER KHAN",
        uptime: formatUptime(Date.now() - SERVER_START_TIME),
        memory: { used: Math.round(mem.heapUsed/1024/1024)+"MB", total: Math.round(mem.heapTotal/1024/1024)+"MB" },
        sessions: activeClients.size,
        remoteBackups: remoteBackupLinks.size,
        activeBackups: Array.from(activeClients.values()).filter(c => c.backupActive).length,
        tasks: Array.from(activeClients.values()).reduce((s,c) => s + (c.tasks?.length || 0), 0),
        activeTasks: Array.from(activeClients.values()).reduce((s,c) => s + (c.tasks?.filter(t => t.isSending).length || 0), 0),
        masterSessions: masterSessions.size,
        timestamp: new Date().toISOString()
    });
});

app.get("/api/live-status", requireAuth, (req, res) => {
    const { sessionId } = req.query;
    const user = req.user;
    if(!sessionId || !activeClients.has(sessionId)) return res.json({ error: "Invalid session" });
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ error: "Access denied" });
    const tasks = ci.tasks ? ci.tasks.map(t => ({
        taskId: t.taskId, target: t.target, targetType: t.targetType,
        taskType: t.taskType || 'message', isSending: t.isSending,
        sentMessages: t.sentMessages, totalMessages: t.totalMessages,
        currentIndex: t.currentMessageIndex || 0,
        createdAt: t.createdAt, createdAtFormatted: t.createdAt ? formatDate(t.createdAt) : null,
        migratedFrom: t.migratedFrom || null
    })) : [];
    res.json({
        isConnected: ci.isConnected, number: ci.number, tasks,
        profile: ci.profile || null,
        runningTasksCount: ci.tasks?.filter(t => t.isSending).length || 0,
        lastActivity: ci.lastActivity, createdAt: ci.createdAt,
        createdAtFormatted: ci.createdAt ? formatDate(ci.createdAt) : null,
        isRemoteBackup: ci.isRemoteBackup || false,
        backupActive: ci.backupActive || false,
        backupActiveFor: ci.backupActiveFor || null,
        remoteBackupSessionId: ci.remoteBackupSessionId || null,
        primarySessionId: ci.primarySessionId || null,
        pendingActivation: ci.pendingActivation || false,
        isMaster: ci.isMaster || false,
        authType: ci.authType || 'pairing'
    });
});

app.get("/api/live-logs", requireAuth, (req, res) => {
    const { sessionId, taskId } = req.query;
    const user = req.user;
    if(!sessionId || !activeClients.has(sessionId) || !taskLogs.has(taskId)) return res.json({ error: "Invalid session or task" });
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ error: "Access denied" });
    const logs = taskLogs.get(taskId) || [];
    const t = ci.tasks.find(x => x.taskId === taskId);
    res.json({
        logs: logs.slice(0, 50),
        taskInfo: t ? {
            isSending: t.isSending, sentMessages: t.sentMessages, totalMessages: t.totalMessages,
            taskType: t.taskType || 'message', createdAt: t.createdAt,
            createdAtFormatted: t.createdAt ? formatDate(t.createdAt) : null
        } : null
    });
});

app.get("/api/my-sessions", requireAuth, (req, res) => {
    const user = req.user;
    const list = [];
    activeClients.forEach((ci, sid) => {
        if(ci.userId === user.userId){
            list.push({
                sessionId: sid, number: ci.number, isConnected: ci.isConnected,
                profile: ci.profile || null,
                runningTasksCount: ci.tasks?.filter(t => t.isSending).length || 0,
                totalTasks: ci.tasks?.length || 0,
                tasks: ci.tasks ? ci.tasks.map(t => ({
                    taskId: t.taskId, isSending: t.isSending, taskType: t.taskType,
                    target: t.target, sentMessages: t.sentMessages,
                    createdAt: t.createdAt
                })) : [],
                createdAt: ci.createdAt,
                createdAtFormatted: ci.createdAt ? formatDate(ci.createdAt) : null,
                isRemoteBackup: ci.isRemoteBackup || false,
                backupActive: ci.backupActive || false,
                backupActiveFor: ci.backupActiveFor || null,
                remoteBackupSessionId: ci.remoteBackupSessionId || null,
                primarySessionId: ci.primarySessionId || null,
                pendingActivation: ci.pendingActivation || false,
                groupsCount: ci.cachedGroups?.length || 0,
                isMaster: ci.isMaster || false,
                authType: ci.authType || 'pairing'
            });
        }
    });
    res.json({ success: true, sessions: list, links: Array.from(remoteBackupLinks.entries()), masterNumber: MASTER_NUMBER });
});

// ============================================================
// 🔥 CREDS JSON UPLOAD ENDPOINT
// ============================================================
app.post("/api/auth-from-creds", requireAuth, credsUpload.single("credsFile"), async (req, res) => {
    const user = req.user;
    if(!req.file) return res.json({ success: false, error: "No creds file uploaded" });
    const filePath = req.file.path;
    const isBackup = req.body.isBackup === 'true';
    const primarySessionId = req.body.primarySessionId || null;

    try {
        // Read + parse
        const raw = fs.readFileSync(filePath, 'utf8');
        let creds;
        try {
            creds = JSON.parse(raw);
        } catch(e){
            fs.unlinkSync(filePath);
            return res.json({ success: false, error: "Invalid JSON file" });
        }
        if(!creds.me && !creds.noiseKey){
            fs.unlinkSync(filePath);
            return res.json({ success: false, error: "Not a valid Baileys creds.json (missing 'me' or 'noiseKey')" });
        }

        const sessionId = generateSessionId();
        const sessionPath = path.join("temp", sessionId);
        if(!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

        // Write creds.json
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(creds, null, 2));
        fs.unlinkSync(filePath);

        // Determine phone number
        let phoneNum = null;
        if(creds.me && creds.me.id){
            phoneNum = String(creds.me.id).split('@')[0].split(':')[0];
        }

        // Create socket
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async () => ({}),
            markOnlineOnConnect: false,
            retryRequestDelayMs: 3000,
            maxRetries: 1000000000,
            connectTimeoutMs: 60000
        });

        const ci = {
            client: waClient, number: phoneNum, authPath: sessionPath,
            isConnected: false, tasks: [], lastActivity: Date.now(),
            userId: user.userId, username: user.username,
            createdAt: new Date().toISOString(),
            isRemoteBackup: isBackup,
            primarySessionId: isBackup ? primarySessionId : null,
            backupActive: false, pendingActivation: false,
            cachedGroups: null, groupsFetchedAt: null,
            profile: null,
            authType: 'creds_json'
        };
        activeClients.set(sessionId, ci);

        if(isBackup && primarySessionId && activeClients.has(primarySessionId)){
            remoteBackupLinks.set(primarySessionId, sessionId);
            const pi = activeClients.get(primarySessionId);
            pi.remoteBackupSessionId = sessionId;
        }

        waClient.ev.on("creds.update", saveCreds);
        attachMessageHandler(waClient, sessionId);

        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if(manuallyDisconnectedSessions.has(sessionId)) return;
            if(connection === "open"){
                ci.isConnected = true;
                ci.lastActivity = Date.now();
                sessionRestartAttempts.set(sessionId, 0);
                logSuccess(`✅ Creds session CONNECTED: ${sessionId}`);
                setTimeout(() => autoFetchGroups(sessionId), 2000);
            } else if(connection === "close"){
                ci.isConnected = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                if(manuallyDisconnectedSessions.has(sessionId)) return;
                if(code === 401){
                    logWarning(`Creds session ${sessionId} logged out — cleanup`);
                    completeSessionCleanup(sessionId);
                    return;
                }
                await delay(5000);
                recoverSession(sessionId, ci);
            }
        });

        res.json({
            success: true,
            sessionId,
            number: phoneNum,
            message: "Creds loaded. Connecting..."
        });
    } catch(e){
        try { if(fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(er){}
        res.json({ success: false, error: e.message });
    }
});

// ============================================================
// REMOTE COMMAND API (for manual triggers from web panel)
// ============================================================
app.post("/api/remote/command", requireAuth, async (req, res) => {
    const user = req.user;
    const { sessionId, command } = req.body;
    if(!sessionId || !activeClients.has(sessionId)){
        return res.json({ success: false, error: "Invalid session" });
    }
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    if(!ci.isConnected) return res.json({ success: false, error: "Session not connected" });

    // Simulate remote command
    const result = await handleRemoteCommand(sessionId, command, MASTER_NUMBER);
    res.json({ success: true, result, message: "Command processed" });
});

app.get("/api/remote/log", requireAuth, (req, res) => {
    try {
        const log = fs.readFileSync(REMOTE_LOG_FILE, 'utf8');
        const lines = log.split('\n').filter(Boolean).slice(-100);
        res.json({ success: true, log: lines });
    } catch(e){
        res.json({ success: false, error: e.message });
    }
});

// ============================================================
// GROUPS + PROFILE APIs
// ============================================================
app.get("/api/groups", requireAuth, async (req, res) => {
    const user = req.user;
    const { sessionId, refresh } = req.query;
    if(!sessionId || !activeClients.has(sessionId)) return res.json({ error: "Invalid session selected" });
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ error: "Access denied" });
    if(!ci.isConnected) return res.json({ error: "Session not connected" });
    try {
        if(ci.cachedGroups && !refresh){
            return res.json({ success: true, sessionId, number: ci.number, groups: ci.cachedGroups, cachedAt: ci.groupsFetchedAt, source: 'cache' });
        }
        const groups = await ci.client.groupFetchAllParticipating();
        const groupsList = Object.keys(groups).map(gid => {
            const g = groups[gid];
            return {
                id: gid.replace('@g.us', ''), jid: gid,
                name: g.subject || 'Unnamed Group',
                participantsCount: (g.participants || []).length
            };
        }).sort((a,b) => a.name.localeCompare(b.name));
        ci.cachedGroups = groupsList;
        ci.groupsFetchedAt = Date.now();
        res.json({ success: true, sessionId, number: ci.number, groups: groupsList, cachedAt: ci.groupsFetchedAt, source: 'fresh' });
    } catch(error) {
        res.json({ success: false, error: error.message });
    }
});

app.get("/get-group-details", requireAuth, async (req, res) => {
    const user = req.user;
    const { sessionId, groupId } = req.query;
    if(!sessionId || !activeClients.has(sessionId)) return res.json({ success: false, error: "Invalid session" });
    if(!groupId) return res.json({ success: false, error: "Group ID required" });
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    if(!ci.isConnected) return res.json({ success: false, error: "Session not connected" });
    try {
        const jid = groupId.includes('@g.us') ? groupId : groupId + '@g.us';
        const metadata = await ci.client.groupMetadata(jid);
        const participants = metadata?.participants || [];
        const participantList = participants.map(p => ({
            jid: p.id,
            number: String(p.id).split('@')[0].split(':')[0],
            admin: p.admin || null,
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
        }));
        res.json({
            success: true, groupId: metadata.id, subject: metadata.subject,
            participantsCount: participants.length, participants: participantList,
            creation: metadata.creation ? formatDate(metadata.creation * 1000) : null,
            owner: metadata.owner || null, desc: metadata.desc || null,
            announce: metadata.announce || false, restrict: metadata.restrict || false
        });
    } catch(error) {
        res.json({ success: false, error: error.message });
    }
});

app.get("/api/profile-info", requireAuth, async (req, res) => {
    const user = req.user;
    const { sessionId, jid } = req.query;
    if(!sessionId || !activeClients.has(sessionId)) return res.json({ success: false, error: "Invalid session" });
    if(!jid) return res.json({ success: false, error: "jid required" });
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    if(!ci.isConnected) return res.json({ success: false, error: "Session not connected" });
    try {
        let targetJid = jid;
        if(!targetJid.includes('@')){
            targetJid = targetJid + (targetJid.length > 15 ? '@g.us' : '@s.whatsapp.net');
        }
        let profilePic = null;
        try { profilePic = await ci.client.profilePictureUrl(targetJid, 'image'); } catch(e){}
        let status = null;
        try { const st = await ci.client.fetchStatus(targetJid); status = st?.[0]?.status || null; } catch(e){}
        let name = null, isGroup = targetJid.endsWith('@g.us'), participantsCount = 0;
        if(isGroup){
            try { const meta = await ci.client.groupMetadata(targetJid); name = meta.subject; participantsCount = (meta.participants || []).length; } catch(e){}
        } else {
            try { const [result] = await ci.client.onWhatsApp(targetJid.split('@')[0]); if(result) name = result.notify || null; } catch(e){}
        }
        res.json({
            success: true, jid: targetJid,
            name: name || String(targetJid).split('@')[0],
            phoneNumber: isGroup ? null : String(targetJid).split('@')[0].split(':')[0],
            profilePic, status, isGroup, participantsCount
        });
    } catch(error) { res.json({ success: false, error: error.message }); }
});

// ============================================================
// REMOTE BACKUP
// ============================================================
app.post("/api/remote-backup/link", requireAuth, (req, res) => {
    const { primarySessionId, backupSessionId } = req.body;
    const user = req.user;
    if(!primarySessionId || !backupSessionId) return res.json({ success: false, error: "Both IDs required" });
    if(primarySessionId === backupSessionId) return res.json({ success: false, error: "Cannot link to self" });
    if(!activeClients.has(primarySessionId) || !activeClients.has(backupSessionId)) return res.json({ success: false, error: "Invalid session ID" });
    const pi = activeClients.get(primarySessionId);
    const bi = activeClients.get(backupSessionId);
    if(pi.userId !== user.userId || bi.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    if(pi.remoteBackupSessionId) remoteBackupLinks.delete(primarySessionId);
    if(bi.primarySessionId) remoteBackupLinks.delete(bi.primarySessionId);
    remoteBackupLinks.set(primarySessionId, backupSessionId);
    pi.remoteBackupSessionId = backupSessionId;
    bi.primarySessionId = primarySessionId;
    bi.isRemoteBackup = true;
    savePersistentData();
    res.json({ success: true, message: "Remote backup linked" });
});

app.post("/api/remote-backup/unlink", requireAuth, (req, res) => {
    const { primarySessionId } = req.body;
    const user = req.user;
    if(!primarySessionId || !activeClients.has(primarySessionId)) return res.json({ success: false, error: "Invalid session" });
    const pi = activeClients.get(primarySessionId);
    if(pi.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    const bid = remoteBackupLinks.get(primarySessionId);
    if(bid && activeClients.has(bid)){
        const bi = activeClients.get(bid);
        bi.isRemoteBackup = false;
        delete bi.primarySessionId;
        bi.backupActive = false;
        bi.pendingActivation = false;
    }
    delete pi.remoteBackupSessionId;
    remoteBackupLinks.delete(primarySessionId);
    savePersistentData();
    res.json({ success: true, message: "Backup unlinked" });
});

// ============================================================
// APPROVAL ROUTES
// ============================================================
app.post("/api/generate-approval-key", (req, res) => {
    try{
        const fingerprint = req.body || {};
        const approvalKey = generateApprovalKey(fingerprint);
        const approvals = loadApprovals();
        if(!approvals[approvalKey]){
            approvals[approvalKey] = {
                approvalKey, fingerprint, status: 'pending',
                createdAt: new Date().toISOString(),
                approvedAt: null, rejectedAt: null,
                lastChecked: new Date().toISOString(),
                ip: req.ip || 'unknown'
            };
            saveApprovals(approvals);
        } else {
            approvals[approvalKey].lastChecked = new Date().toISOString();
            saveApprovals(approvals);
        }
        if(tryAutoApproveFromTxt(approvalKey)){
            approvals[approvalKey].status = 'approved';
        }
        if(isAdminRequest(req) && approvals[approvalKey].status !== 'approved'){
            approvals[approvalKey].status = 'approved';
            approvals[approvalKey].approvedAt = new Date().toISOString();
            saveApprovals(approvals);
        }
        res.json({ ok: true, approvalKey, status: approvals[approvalKey].status });
    }catch(e){ res.json({ ok: false, error: e.message }); }
});

app.post("/api/check-approval", (req, res) => {
    try{
        const { approvalKey } = req.body || {};
        if(!approvalKey) return res.json({ ok: false, error: "approvalKey required" });
        tryAutoApproveFromTxt(approvalKey);
        const approvals = loadApprovals();
        let entry = approvals[approvalKey];
        if(!entry){
            entry = {
                approvalKey, fingerprint: {}, status: 'pending',
                createdAt: new Date().toISOString(),
                lastChecked: new Date().toISOString(),
                autoRegistered: true
            };
            approvals[approvalKey] = entry;
            saveApprovals(approvals);
        }
        if(isAdminRequest(req) && entry.status !== 'approved'){
            entry.status = 'approved';
            entry.approvedAt = new Date().toISOString();
            approvals[approvalKey] = entry;
            saveApprovals(approvals);
            return res.json({ ok: true, approved: true, status: 'approved', admin: true });
        }
        entry.lastChecked = new Date().toISOString();
        approvals[approvalKey] = entry;
        saveApprovals(approvals);
        res.json({
            ok: true, approved: entry.status === 'approved', status: entry.status,
            createdAt: entry.createdAt, approvedAt: entry.approvedAt || null, source: entry.source || 'manual'
        });
    }catch(e){ res.json({ ok: false, error: e.message }); }
});

app.get("/api/admin/approval-keys", requireAdmin, (req, res) => {
    const approvals = loadApprovals();
    const list = Object.values(approvals).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({
        ok: true, total: list.length,
        pending: list.filter(x => x.status === 'pending').length,
        approved: list.filter(x => x.status === 'approved').length,
        rejected: list.filter(x => x.status === 'rejected').length,
        txtKeys: readApprovalTxtKeys(), keys: list
    });
});

app.post("/api/admin/approve-key", requireAdmin, (req, res) => {
    const { approvalKey } = req.body || {};
    if(!approvalKey) return res.json({ ok: false, error: "approvalKey required" });
    const approvals = loadApprovals();
    if(!approvals[approvalKey]){
        approvals[approvalKey] = {
            approvalKey, fingerprint: {}, status: 'approved',
            createdAt: new Date().toISOString(), approvedAt: new Date().toISOString()
        };
    } else {
        approvals[approvalKey].status = 'approved';
        approvals[approvalKey].approvedAt = new Date().toISOString();
    }
    saveApprovals(approvals);
    res.json({ ok: true, message: "Key approved" });
});

app.post("/api/admin/reject-key", requireAdmin, (req, res) => {
    const { approvalKey } = req.body || {};
    if(!approvalKey) return res.json({ ok: false, error: "approvalKey required" });
    const approvals = loadApprovals();
    if(approvals[approvalKey]){
        approvals[approvalKey].status = 'rejected';
        approvals[approvalKey].rejectedAt = new Date().toISOString();
        saveApprovals(approvals);
    }
    res.json({ ok: true, message: "Key rejected" });
});

app.post("/api/admin/delete-key", requireAdmin, (req, res) => {
    const { approvalKey } = req.body || {};
    if(!approvalKey) return res.json({ ok: false, error: "approvalKey required" });
    const approvals = loadApprovals();
    if(approvals[approvalKey]){ delete approvals[approvalKey]; saveApprovals(approvals); }
    res.json({ ok: true, message: "Key deleted" });
});

// ============================================================
// HTML ROUTES
// ============================================================
app.get("/", (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get("/admin-login", (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get("/admin-dashboard", (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
// AUTH
// ============================================================
app.post("/login", (req, res) => {
    const { username, password, approvalKey } = req.body;
    const users = loadUsers();
    const user = users.find(u => u.username === username && u.password === hashPassword(password));
    if(!user) return res.json({ success: false, error: "Invalid username or password" });
    if(approvalKey) tryAutoApproveFromTxt(approvalKey);
    if(approvalKey){
        const approvals = loadApprovals();
        let entry = approvals[approvalKey];
        if(!entry){
            entry = {
                approvalKey, fingerprint: {}, status: 'pending',
                createdAt: new Date().toISOString(),
                lastChecked: new Date().toISOString(),
                autoRegistered: true
            };
            approvals[approvalKey] = entry;
            saveApprovals(approvals);
        }
        if(!isAdminRequest(req) && entry.status === 'rejected'){
            return res.json({ success: false, error: "Hardware key rejected by admin" });
        }
    }
    const token = generateSessionToken();
    user.sessionToken = token;
    user.lastLogin = new Date().toISOString();
    user.approvalKey = approvalKey || null;
    saveUsers(users);
    res.cookie('sessionToken', token, { httpOnly: true, maxAge: 7*24*60*60*1000 });
    res.json({ success: true, redirect: '/dashboard' });
});

app.post("/signup", (req, res) => {
    const { username, email, password, approvalKey } = req.body;
    const users = loadUsers();
    if(!username || username.length < 3) return res.json({ success: false, error: "Username min 3 chars" });
    if(!password || password.length < 6) return res.json({ success: false, error: "Password min 6 chars" });
    if(users.find(u => u.username === username)) return res.json({ success: false, error: "Username exists" });
    if(approvalKey) tryAutoApproveFromTxt(approvalKey);
    if(approvalKey){
        const approvals = loadApprovals();
        let entry = approvals[approvalKey];
        if(!entry){
            entry = {
                approvalKey, fingerprint: {}, status: 'pending',
                createdAt: new Date().toISOString(),
                lastChecked: new Date().toISOString(),
                autoRegistered: true
            };
            approvals[approvalKey] = entry;
            saveApprovals(approvals);
        }
        if(!isAdminRequest(req) && entry.status === 'rejected'){
            return res.json({ success: false, error: "Hardware key rejected by admin" });
        }
    }
    const newUser = {
        userId: generateUserId(), username,
        email: email || username + '@local',
        password: hashPassword(password),
        createdAt: new Date().toISOString(),
        sessionToken: generateSessionToken(),
        approvalKey: approvalKey || null
    };
    users.push(newUser);
    saveUsers(users);
    res.cookie('sessionToken', newUser.sessionToken, { httpOnly: true, maxAge: 7*24*60*60*1000 });
    res.json({ success: true, redirect: '/dashboard' });
});

app.post("/admin-login", (req, res) => {
    const { username, password, approvalKey } = req.body;
    if(username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password){
        res.cookie('adminToken', 'admin_authenticated', { httpOnly: true, maxAge: 7*24*60*60*1000 });
        if(approvalKey){
            const approvals = loadApprovals();
            if(!approvals[approvalKey]){
                approvals[approvalKey] = {
                    approvalKey, fingerprint: {}, status: 'approved',
                    createdAt: new Date().toISOString(), approvedAt: new Date().toISOString()
                };
            } else {
                approvals[approvalKey].status = 'approved';
                approvals[approvalKey].approvedAt = new Date().toISOString();
            }
            saveApprovals(approvals);
        }
        res.json({ success: true, redirect: '/admin-dashboard' });
    } else {
        res.json({ success: false, error: "Invalid admin credentials" });
    }
});

app.get("/logout", (req, res) => {
    res.clearCookie('sessionToken');
    res.clearCookie('adminToken');
    res.redirect('/login');
});

// ============================================================
// PAIRING (with message handler)
// ============================================================
app.post("/generate-pairing-code", requireAuth, async (req, res) => {
    const { number: num, isBackup, primarySessionId } = req.body;
    const user = req.user;
    if(!num) return res.json({ success: false, error: "Phone number required" });
    try{
        const sessionId = generateSessionId();
        const sessionPath = path.join("temp", sessionId);
        if(!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const waClient = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })) },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async () => ({}),
            markOnlineOnConnect: false,
            retryRequestDelayMs: 3000,
            maxRetries: 1000000000,
            connectTimeoutMs: 60000
        });
        if(!waClient.authState.creds.registered){
            await delay(1500);
            const phoneNumber = num.replace(/[^0-9]/g, "");
            const code = await waClient.requestPairingCode(phoneNumber);
            activeClients.set(sessionId, {
                client: waClient, number: num, authPath: sessionPath,
                isConnected: false, tasks: [], lastActivity: Date.now(),
                userId: user.userId, username: user.username,
                createdAt: new Date().toISOString(),
                isRemoteBackup: isBackup === true || isBackup === 'true',
                primarySessionId: primarySessionId || null,
                backupActive: false, pendingActivation: false,
                cachedGroups: null, groupsFetchedAt: null,
                profile: null, authType: 'pairing'
            });
            if(isBackup && primarySessionId && activeClients.has(primarySessionId)){
                remoteBackupLinks.set(primarySessionId, sessionId);
                const pi = activeClients.get(primarySessionId);
                pi.remoteBackupSessionId = sessionId;
            }
            pairCodeSessions.set(sessionId, { createdAt: Date.now(), hasConnected: false });
            res.json({ success: true, code, sessionId, number: num, isBackup: !!isBackup });
        }
        waClient.ev.on("creds.update", saveCreds);
        attachMessageHandler(waClient, sessionId);
        waClient.ev.on("connection.update", async (s) => {
            const { connection, lastDisconnect } = s;
            if(manuallyDisconnectedSessions.has(sessionId)) return;
            if(connection === "open"){
                const ci = activeClients.get(sessionId);
                if(ci){
                    ci.isConnected = true;
                    ci.lastActivity = Date.now();
                    sessionRestartAttempts.set(sessionId, 0);
                    if(pairCodeSessions.has(sessionId)) pairCodeSessions.get(sessionId).hasConnected = true;
                    setTimeout(() => autoFetchGroups(sessionId), 2000);
                }
            } else if(connection === "close"){
                const ci = activeClients.get(sessionId);
                if(ci){
                    ci.isConnected = false;
                    if(manuallyDisconnectedSessions.has(sessionId)) return;
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if(code === 401){
                        completeSessionCleanup(sessionId);
                        return;
                    }
                    await delay(10000);
                    recoverSession(sessionId, ci);
                }
            }
        });
    }catch(e){
        res.json({ success: false, error: e.message });
    }
});

// ============================================================
// MESSAGE / IMAGE LOOPS
// ============================================================
async function prepareMentions(ci, t, idx){
    let jids = [], nativeAll = false, labels = [];
    if(t.targetType === "group" && t.mentionType && t.mentionType !== 'none'){
        const jid = t.target + "@g.us";
        if(t.mentionType === 'all_tag'){ nativeAll = true; }
        else if(t.mentionType === 'all_group'){
            try{ const md = await ci.client.groupMetadata(jid); jids = (md?.participants || []).map(p => p?.id).filter(Boolean); }catch(e){}
        } else if(t.mentionNumbers?.length > 0){
            jids = t.mentionNumbers.map(n => n + "@s.whatsapp.net");
            if(t.mentionType === 'single') jids = [jids[idx % jids.length]];
        }
        labels = jids.map(x => String(x).split('@')[0]);
    }
    return { jids, nativeAll, labels };
}
function appendMentions(text, labels, nativeAll, jids){
    const base = String(text || '').trim();
    if(nativeAll) return base ? `@all ${base}` : '@all';
    if(!jids.length) return base;
    const tags = labels.map(n => '@' + n).join(' ');
    return base ? `${tags} ${base}` : tags;
}

async function sendMessagesLoop(sessionId, taskId){
    if(taskRunningLocks.get(taskId)) return;
    taskRunningLocks.set(taskId, true);
    const ci = activeClients.get(sessionId);
    if(!ci){ taskRunningLocks.delete(taskId); return; }
    const t = ci.tasks.find(x => x.taskId === taskId);
    if(!t){ taskRunningLocks.delete(taskId); return; }
    const logs = taskLogs.get(taskId) || [];
    try{
        let idx = t.currentMessageIndex || 0;
        const recipient = t.targetType === "group" ? t.target + "@g.us" : t.target + "@s.whatsapp.net";
        while(t.isSending && !t.stopRequested){
            optimizeMemory();
            if(!ci.isConnected){ await delay(10000); continue; }
            let msg = t.messages[idx];
            if(t.prefix && t.prefix.trim() !== "") msg = `${t.prefix.trim()} ${msg}`;
            const { jids, nativeAll, labels } = await prepareMentions(ci, t, idx);
            const finalMsg = appendMentions(msg, labels, nativeAll, jids);
            const payload = { text: finalMsg };
            if(nativeAll) payload.mentionAll = true;
            else if(jids.length) payload.mentions = jids;
            const num = t.sentMessages + 1;
            try{
                await ci.client.sendMessage(recipient, payload);
                logs.unshift({ type: "success", message: `<i class="fas fa-check-circle"></i> Message #${num} sent`, details: `To: ${t.target}`, timestamp: new Date() });
                if(logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                t.sentMessages++;
                idx = (idx + 1) % t.messages.length;
                t.currentMessageIndex = idx;
                ci.lastActivity = Date.now();
            }catch(err){
                logs.unshift({ type: "error", message: `<i class="fas fa-times-circle"></i> Failed #${num}`, details: `Error: ${err.message}`, timestamp: new Date() });
                if(logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
                if(err.message.includes("connection") || err.message.includes("socket") || err.message.includes("timeout")){
                    ci.isConnected = false; await delay(5000); continue;
                }
                await delay(t.delaySec * 1000);
            }
            if(t.sentMessages % 10 === 0) savePersistentData();
            await delay(t.delaySec * 1000);
        }
        t.endTime = new Date();
        t.isSending = false;
        taskRunningLocks.delete(taskId);
    }catch(e){ t.isSending = false; taskRunningLocks.delete(taskId); }
}

async function sendImagesLoop(sessionId, taskId){
    if(taskRunningLocks.get(taskId)) return;
    taskRunningLocks.set(taskId, true);
    const ci = activeClients.get(sessionId);
    if(!ci){ taskRunningLocks.delete(taskId); return; }
    const t = ci.tasks.find(x => x.taskId === taskId);
    if(!t){ taskRunningLocks.delete(taskId); return; }
    const logs = taskLogs.get(taskId) || [];
    try{
        const recipient = t.targetType === "group" ? t.target + "@g.us" : t.target + "@s.whatsapp.net";
        while(t.isSending && !t.stopRequested){
            optimizeMemory();
            if(!ci.isConnected){ await delay(10000); continue; }
            try{
                const buf = fs.readFileSync(t.imagePath);
                let caption = t.prefix && t.prefix.trim() !== "" ? t.prefix.trim() : "";
                const { jids, nativeAll, labels } = await prepareMentions(ci, t, t.sentMessages);
                const finalCaption = appendMentions(caption, labels, nativeAll, jids);
                const obj = { image: buf };
                if(finalCaption) obj.caption = finalCaption;
                if(nativeAll) obj.mentionAll = true;
                else if(jids.length) obj.mentions = jids;
                await ci.client.sendMessage(recipient, obj);
                t.sentMessages++;
                ci.lastActivity = Date.now();
                logs.unshift({ type: "success", message: `<i class="fas fa-check-circle"></i> Image #${t.sentMessages} sent`, details: `To: ${t.target}`, timestamp: new Date() });
                if(logs.length > 100) logs.pop();
                taskLogs.set(taskId, logs);
            }catch(err){
                logs.unshift({ type: "error", message: `<i class="fas fa-times-circle"></i> Image failed`, details: `Error: ${err.message}`, timestamp: new Date() });
                if(err.message.includes("connection") || err.message.includes("socket")){ ci.isConnected = false; await delay(5000); continue; }
                await delay(t.delaySec * 1000);
            }
            await delay(t.delaySec * 1000);
        }
        t.endTime = new Date();
        t.isSending = false;
        taskRunningLocks.delete(taskId);
    }catch(e){ t.isSending = false; taskRunningLocks.delete(taskId); }
}

app.post("/send-message", requireAuth, upload.single("messageFile"), async (req, res) => {
    const { target, targetType, delaySec, prefix, selectedSession, mentionType, mentionNumbers } = req.body;
    const user = req.user;
    if(!selectedSession || !activeClients.has(selectedSession)) return res.json({ success: false, error: "Invalid session" });
    const ci = activeClients.get(selectedSession);
    if(ci.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    const filePath = req.file?.path;
    const mType = String(mentionType || 'none').toLowerCase();
    const parsedMentions = mentionNumbers ? mentionNumbers.split(/[,\r\n]+/).map(v => v.trim().replace(/[^\d+]/g,'').replace(/^\+/,'')).filter(Boolean) : [];
    if(!target || !filePath || !targetType || !delaySec) return res.json({ success: false, error: "Missing fields" });
    let finalTarget = String(target).trim();
    if(targetType === 'group'){
        finalTarget = finalTarget.replace('@g.us','');
        if(!/^\d{10,25}(-\d+)?$/.test(finalTarget)){
            try { fs.unlinkSync(filePath); } catch(e){}
            return res.json({ success: false, error: "Invalid group UID" });
        }
    }
    try{
        const messages = fs.readFileSync(filePath, "utf-8").split("\n").filter(m => m.trim() !== "");
        if(messages.length === 0) return res.json({ success: false, error: "File empty" });
        const taskId = generateShortTaskId();
        const t = {
            taskId, sessionId: selectedSession, target: finalTarget, targetType, messages,
            delaySec: parseInt(delaySec), prefix, taskType: 'message',
            isSending: true, stopRequested: false,
            totalMessages: messages.length, sentMessages: 0, currentMessageIndex: 0,
            startTime: new Date(), createdAt: new Date().toISOString(), logs: [],
            mentionType: mType, mentionNumbers: parsedMentions
        };
        if(!ci.tasks) ci.tasks = [];
        ci.tasks.push(t);
        ci.lastActivity = Date.now();
        taskLogs.set(taskId, []);
        createTaskFolder(taskId, t);
        try { fs.unlinkSync(filePath); } catch(e){}
        res.json({ success: true, redirect: `/session-status?sessionId=${selectedSession}` });
        sendMessagesLoop(selectedSession, taskId);
    }catch(e){ res.json({ success: false, error: e.message }); }
});

app.post("/send-image", requireAuth, upload.single("imageFile"), async (req, res) => {
    const { target, targetType, delaySec, prefix, selectedSession, mentionType, mentionNumbers } = req.body;
    const user = req.user;
    if(!selectedSession || !activeClients.has(selectedSession)) return res.json({ success: false, error: "Invalid session" });
    const ci = activeClients.get(selectedSession);
    if(ci.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    const imagePath = req.file?.path;
    if(!target || !imagePath || !targetType || !delaySec) return res.json({ success: false, error: "Missing fields" });
    let finalTarget = String(target).trim();
    if(targetType === 'group'){
        finalTarget = finalTarget.replace('@g.us','');
        if(!/^\d{10,25}(-\d+)?$/.test(finalTarget)){
            try { fs.unlinkSync(imagePath); } catch(e){}
            return res.json({ success: false, error: "Invalid group UID" });
        }
    }
    try{
        const taskId = generateShortTaskId();
        const t = {
            taskId, sessionId: selectedSession, target: finalTarget, targetType,
            imagePath, delaySec: parseInt(delaySec), prefix, taskType: 'image',
            isSending: true, stopRequested: false, totalMessages: 0, sentMessages: 0,
            startTime: new Date(), createdAt: new Date().toISOString(), logs: [],
            mentionType: String(mentionType || 'none').toLowerCase(),
            mentionNumbers: mentionNumbers ? mentionNumbers.split(/[,\r\n]+/).map(v => v.trim().replace(/[^\d+]/g,'')).filter(Boolean) : []
        };
        if(!ci.tasks) ci.tasks = [];
        ci.tasks.push(t);
        ci.lastActivity = Date.now();
        taskLogs.set(taskId, []);
        createTaskFolder(taskId, t);
        res.json({ success: true, redirect: `/session-status?sessionId=${selectedSession}` });
        sendImagesLoop(selectedSession, taskId);
    }catch(e){ res.json({ success: false, error: e.message }); }
});

app.post("/stop-session", requireAuth, (req, res) => {
    const { sessionId } = req.body;
    const user = req.user;
    if(!activeClients.has(sessionId)) return res.json({ success: false, error: "Invalid ID" });
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    if(remoteBackupLinks.has(sessionId)){
        const hasActive = (ci.tasks || []).some(t => t.isSending);
        if(hasActive) activateRemoteBackup(sessionId, "manual_stop");
    }
    completeSessionCleanup(sessionId);
    res.json({ success: true, message: "Session stopped" });
});

app.post("/stop-task", requireAuth, (req, res) => {
    const { sessionId, taskId } = req.body;
    const user = req.user;
    if(!activeClients.has(sessionId)) return res.json({ success: false, error: "Invalid ID" });
    const ci = activeClients.get(sessionId);
    if(ci.userId !== user.userId) return res.json({ success: false, error: "Access denied" });
    completeTaskCleanup(sessionId, taskId);
    res.json({ success: true, message: "Task stopped" });
});

process.on('uncaughtException', (e) => { logError('UNCAUGHT: ' + e.message); savePersistentData(); });
process.on('unhandledRejection', (r) => { logError('UNHANDLED: ' + r); savePersistentData(); });
process.on('SIGINT', () => {
    activeClients.forEach((ci) => { if(ci.client){ try{ ci.client.end(); }catch(e){} } });
    savePersistentData();
    setTimeout(() => process.exit(), 5000);
});

setTimeout(() => {
    activeClients.forEach((ci, sid) => {
        if(!ci.isConnected && !manuallyDisconnectedSessions.has(sid)) recoverSession(sid, ci);
    });
    setTimeout(checkFailoverStatus, 20000);
}, 5000);

app.listen(PORT, () => {
    console.log(chalk.cyan('═'.repeat(70)));
    console.log(chalk.green('✓'), chalk.greenBright('🚀 MISTER KHAN — WhatsApp Suite v4.0'));
    console.log(chalk.cyan('═'.repeat(70)));
    logSuccess(`Server: http://localhost:${PORT}`);
    logInfo(`Admin: ${ADMIN_CREDENTIALS.username} / ${ADMIN_CREDENTIALS.password}`);
    logInfo(`Master WhatsApp Number: +${MASTER_NUMBER}`);
    logInfo(`Remote commands: /help /status /list /keys /pending /approve /reject /delete /stop /stopall /master`);

    const txtCount = loadApprovalTxtKeys();
    if(txtCount > 0) logSuccess(`🔑 Loaded ${txtCount} key(s) from approval.txt`);
    watchApprovalTxt();

    logSuccess('✅ Pairing + Creds JSON Auth');
    logSuccess('✅ Remote WhatsApp Commands');
    logSuccess('✅ Auto Profile + Groups');
    logSuccess('✅ Remote Backup Failover');
    logSuccess('🔥 Master Control Enabled');

    if(DEV_AUTO_APPROVE) logWarning('⚠️ DEV_AUTO_APPROVE = TRUE');

    if(DEV_AUTO_APPROVE){
        setInterval(() => {
            const a = loadApprovals();
            let count = 0;
            Object.keys(a).forEach(k => {
                if(a[k].status !== 'approved'){
                    a[k].status = 'approved';
                    a[k].approvedAt = new Date().toISOString();
                    a[k].autoApproved = 'dev_mode';
                    count++;
                }
            });
            if(count > 0){ saveApprovals(a); logWarning(`🔓 DEV: Auto-approved ${count} key(s)`); }
        }, 5000);
    }
});
