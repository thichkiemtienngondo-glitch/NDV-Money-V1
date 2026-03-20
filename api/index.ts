import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import bcrypt from "bcryptjs";

// Only try to load .env file if we're not in production (Vercel provides env vars directly)
if (process.env.NODE_ENV !== "production") {
  const envPath = path.resolve(process.cwd(), ".env");
  dotenv.config({ path: envPath });
}

let SUPABASE_URL = process.env.SUPABASE_URL || "";
let SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

const isValidUrl = (url: string) => {
  if (!url) return false;
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
};

const isPlaceholder = (val: string) => 
  !val || val.includes("your-project-id") || val.includes("your-service-role-key") || val === "https://your-project-id.supabase.co";

const app = express();
const router = express.Router();
let supabase: any = null;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Mount router at both root and /api to handle both local and Vercel environments
// When used as a sub-app in server.ts, it will be mounted at /api, 
// so requests to /api/data will reach here as /data.
app.use("/api", router);
app.use("/", router);

// Helper to safely stringify data that might contain BigInt
const safeJsonStringify = (data: any) => {
  return JSON.stringify(data, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
};

// Helper to send JSON response safely
const sendSafeJson = (res: express.Response, data: any, status = 200) => {
  try {
    const json = safeJsonStringify(data);
    res.status(status).set('Content-Type', 'application/json').send(json);
  } catch (e: any) {
    console.error("[API ERROR] Failed to serialize JSON:", e);
    res.status(500).json({
      error: "Lỗi serialization",
      message: "Không thể chuyển đổi dữ liệu sang JSON: " + e.message
    });
  }
};

// Safe initialization function
const initSupabase = () => {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

  console.log(`[API] Attempting to initialize Supabase. URL present: ${!!url}, Key present: ${!!key}`);

  if (url && key && isValidUrl(url) && !isPlaceholder(url) && !isPlaceholder(key)) {
    try {
      supabase = createClient(url, key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      });
      console.log("[API] Supabase client initialized successfully.");
      return supabase;
    } catch (e) {
      console.error("[API] Supabase init error:", e);
      return null;
    }
  }
  console.warn("[API] Supabase credentials missing or invalid.");
  return null;
};

// Initialize once at module level
initSupabase();

const STORAGE_LIMIT_MB = 45; // Virtual limit for demo purposes

// Debug middleware to log incoming requests
router.use((req, res, next) => {
  console.log(`[API DEBUG] ${req.method} ${req.url}`);
  next();
});

// Middleware to check Supabase configuration
router.use((req, res, next) => {
  // Allow health checks without Supabase
  if (req.path.includes('/api-health') || req.path.includes('/supabase-status')) return next();
  
  const client = initSupabase();

  if (!client) {
    return res.status(500).json({
      error: "Cấu hình Supabase không hợp lệ",
      message: "Hệ thống chưa được cấu hình Supabase URL hoặc Service Role Key trên Vercel. Vui lòng kiểm tra Settings -> Environment Variables."
    });
  }
  next();
});

// Helper to estimate JSON size in MB
const getStorageUsage = (data: any) => {
  try {
    const str = safeJsonStringify(data);
    return (Buffer.byteLength(str, 'utf8') / (1024 * 1024));
  } catch (e) {
    console.error("Error calculating storage usage:", e);
    return 0;
  }
};

let isCleaningUp = false;

// Auto-cleanup task: Delete old notifications and loans efficiently
const autoCleanupStorage = async () => {
  const client = initSupabase();
  if (!client || isCleaningUp) return;
  
  isCleaningUp = true;
  try {
    console.log("[Cleanup] Starting storage cleanup...");
    const now = new Date();
    
    // 1. Cleanup Notifications: Delete all but the 10 most recent per user
    const { data: allNotifs, error: fetchError } = await client.from('notifications')
      .select('id, userId')
      .order('id', { ascending: false });
    
    if (fetchError) throw fetchError;

    if (allNotifs && allNotifs.length > 0) {
      const userNotifCounts: Record<string, number> = {};
      const idsToDelete: string[] = [];
      
      for (const notif of allNotifs) {
        userNotifCounts[notif.userId] = (userNotifCounts[notif.userId] || 0) + 1;
        if (userNotifCounts[notif.userId] > 3) {
          idsToDelete.push(notif.id);
        }
      }
      
      if (idsToDelete.length > 0) {
        for (let i = 0; i < idsToDelete.length; i += 100) {
          const chunk = idsToDelete.slice(i, i + 100);
          await client.from('notifications').delete().in('id', chunk);
        }
        console.log(`[Cleanup] Deleted ${idsToDelete.length} old notifications`);
      }
    }

    // 2. Cleanup Loans: Delete Rejected and Settled (>3d)
    // This mechanism keeps the database clean by removing old history
    // Rejected loans are deleted after 3 days
    // Settled loans are deleted after 3 days to save storage space
    const threeDaysAgo = now.getTime() - (3 * 24 * 60 * 60 * 1000);

    const { error: err1 } = await client.from('loans')
      .delete()
      .eq('status', 'BỊ TỪ CHỐI')
      .lt('updatedAt', threeDaysAgo);
    
    const { error: err2 } = await client.from('loans')
      .delete()
      .eq('status', 'ĐÃ TẤT TOÁN')
      .lt('updatedAt', threeDaysAgo);

    if (err1 || err2) console.error("[Cleanup] Error deleting old loans:", JSON.stringify(err1 || err2));
    
    console.log("[Cleanup] Storage cleanup completed.");
  } catch (e) {
    console.error("Lỗi auto-cleanup:", e);
  } finally {
    isCleaningUp = false;
  }
};

// Supabase Status check for Admin
router.get("/supabase-status", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) {
      return res.json({ 
        connected: false, 
        error: "Chưa cấu hình Supabase hoặc URL không hợp lệ. Vui lòng kiểm tra biến môi trường." 
      });
    }
    
    // Use a more standard count query
    const { error } = await client.from('users').select('*', { count: 'exact', head: true });
    
    if (error) {
      console.error("Supabase connection error details:", JSON.stringify(error));
      return res.json({ 
        connected: false, 
        error: `Lỗi kết nối Supabase: ${error.message} (${error.code})` 
      });
    }
    
    res.json({ connected: true, message: "Kết nối Supabase ổn định" });
  } catch (e: any) {
    console.error("Critical error in /supabase-status:", e);
    res.json({ connected: false, error: `Lỗi hệ thống: ${e.message}` });
  }
});

// API Routes
router.post("/login", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    
    const { phone, password } = req.body;
    
    // Admin hardcoded check (as per App.tsx logic)
    if (phone === '0877203996' && password === '119011') {
      return res.json({
        success: true,
        user: {
          id: 'AD01', phone: '0877203996', fullName: 'QUẢN TRỊ VIÊN', idNumber: 'SYSTEM_ADMIN',
          balance: 500000000, totalLimit: 500000000, rank: 'diamond', rankProgress: 10,
          isLoggedIn: true, isAdmin: true
        }
      });
    }

    const { data: users, error } = await client
      .from('users')
      .select('*')
      .eq('phone', phone)
      .limit(1);

    if (error) throw error;
    
    const user = users?.[0];
    if (!user) {
      return res.status(401).json({ error: "Số điện thoại hoặc mật khẩu không chính xác." });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password || '');
    if (!isMatch) {
      return res.status(401).json({ error: "Số điện thoại hoặc mật khẩu không chính xác." });
    }

    // Remove password before sending
    const { password: _, ...userWithoutPassword } = user;
    
    res.json({
      success: true,
      user: userWithoutPassword
    });
  } catch (e: any) {
    console.error("Lỗi login:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.get("/data", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) {
      return res.status(500).json({
        error: "Cấu hình Supabase không hợp lệ",
        message: "Hệ thống chưa được cấu hình Supabase URL hoặc Service Role Key."
      });
    }

    const userId = req.query.userId as string;
    const isAdmin = req.query.isAdmin === 'true';

    // Individual query functions with role-based filtering
    const fetchUsers = async () => {
      try {
        // Security: Only fetch full columns if explicitly requested (e.g. for profile or admin edit)
        // AND ensure password is NEVER included in data fetch
        const columns = (req.query.full === 'true' ? USER_COLUMNS : USER_SUMMARY_COLUMNS)
          .filter(c => c !== 'password')
          .join(',');
          
        let query = client.from('users').select(columns);
        
        // SECURITY: If not admin, ONLY allow fetching own data
        if (!isAdmin) {
          if (!userId) return [];
          query = query.eq('id', userId);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch users:", e.message || e);
        return [];
      }
    };

    const fetchLoans = async () => {
      try {
        const columns = req.query.full === 'true' ? LOAN_COLUMNS.join(',') : LOAN_SUMMARY_COLUMNS.join(',');
        let query = client.from('loans').select(columns);
        if (!isAdmin && userId) {
          query = query.eq('userId', userId);
        }
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch loans:", e.message || e);
        return [];
      }
    };

    const fetchNotifications = async () => {
      try {
        let query = client.from('notifications').select('*').order('id', { ascending: false });
        if (!isAdmin && userId) {
          query = query.eq('userId', userId);
        }
        const { data, error } = await query.limit(100);
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch notifications:", e.message || e);
        return [];
      }
    };

    const fetchConfig = async () => {
      try {
        const { data, error } = await client.from('config').select('*');
        if (error) throw error;
        return data || [];
      } catch (e: any) {
        console.error("Lỗi fetch config:", e.message || e);
        return [];
      }
    };

    // Parallelize queries
    const [users, loans, notifications, config] = await Promise.all([
      fetchUsers(),
      fetchLoans(),
      fetchNotifications(),
      fetchConfig()
    ]);

    const budget = Number(config?.find(c => c.key === 'budget')?.value) || 30000000;
    const rankProfit = Number(config?.find(c => c.key === 'rankProfit')?.value) || 0;
    const loanProfit = Number(config?.find(c => c.key === 'loanProfit')?.value) || 0;
    const monthlyStats = config?.find(c => c.key === 'monthlyStats')?.value || [];

    const payload = {
      users,
      loans,
      notifications,
      budget,
      rankProfit,
      loanProfit,
      monthlyStats
    };

    console.log(`[API] Data fetch successful. Users: ${users.length}, Loans: ${loans.length}`);

    // Only calculate storage usage if explicitly requested
    let usage = 0;
    if (req.query.checkStorage === 'true') {
      usage = getStorageUsage(payload);
    }
    
    const isFull = usage > STORAGE_LIMIT_MB;

    // Run cleanup in background if usage is high
    if (usage > STORAGE_LIMIT_MB * 0.8) {
      autoCleanupStorage();
    }

    sendSafeJson(res, {
      ...payload,
      storageFull: isFull,
      storageUsage: usage.toFixed(2)
    });
  } catch (e: any) {
    console.error("Lỗi nghiêm trọng trong /api/data:", e);
    res.status(500).json({ 
      error: "Lỗi hệ thống", 
      message: `Đã xảy ra lỗi nghiêm trọng: ${e.message || "Không xác định"}. Vui lòng kiểm tra lại kết nối Supabase.` 
    });
  }
});

router.post("/users", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const incomingUsers = req.body;
    if (!Array.isArray(incomingUsers)) {
      return res.status(400).json({ error: "Dữ liệu phải là mảng" });
    }

    // Hash passwords for new users
    const processedUsers = await Promise.all(incomingUsers.map(async (u) => {
      if (u.password && !u.password.startsWith('$2a$')) { // Simple check if already hashed
        const salt = await bcrypt.genSalt(10);
        u.password = await bcrypt.hash(u.password, salt);
      }
      return u;
    }));

    const sanitizedUsers = sanitizeData(processedUsers, USER_COLUMNS);
    if (sanitizedUsers.length === 0) {
      return res.status(400).json({ error: "Không có dữ liệu hợp lệ để lưu" });
    }

    // Bulk upsert is much more efficient than a loop
    const { error } = await client.from('users').upsert(sanitizedUsers, { onConflict: 'id' });
    if (error) {
      console.error("Lỗi upsert users:", JSON.stringify(error));
      return res.status(500).json({ 
        error: "Lỗi cơ sở dữ liệu", 
        message: error.message, 
        code: error.code,
        hint: error.hint || "Hãy đảm bảo bạn đã chạy SQL schema trong Supabase SQL Editor."
      });
    }
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      sanitizedUsers.forEach(u => {
        io.to(`user_${u.id}`).emit("user_updated", u);
      });
      io.to("admin").emit("users_updated", sanitizedUsers);
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/users:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/loans", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const incomingLoans = req.body;
    if (!Array.isArray(incomingLoans)) {
      return res.status(400).json({ error: "Dữ liệu phải là mảng" });
    }

    // Anti-replay check for bankTransactionId
    for (const loan of incomingLoans) {
      if (loan.bankTransactionId) {
        const { data: existing, error: checkError } = await client
          .from('loans')
          .select('id')
          .eq('bankTransactionId', loan.bankTransactionId)
          .neq('id', loan.id)
          .limit(1);
        
        if (checkError) {
          console.error("Lỗi check bankTransactionId:", JSON.stringify(checkError));
        } else if (existing && existing.length > 0) {
          return res.status(400).json({ 
            error: "Giao dịch đã tồn tại", 
            message: `Mã giao dịch ${loan.bankTransactionId} đã được sử dụng cho một khoản vay khác. Vui lòng kiểm tra lại.` 
          });
        }
      }
    }

    const sanitizedLoans = sanitizeData(incomingLoans, LOAN_COLUMNS);
    if (sanitizedLoans.length === 0) {
      return res.status(400).json({ error: "Không có dữ liệu hợp lệ để lưu" });
    }

    // Bulk upsert
    const { error } = await client.from('loans').upsert(sanitizedLoans, { onConflict: 'id' });
    if (error) {
      console.error("Lỗi upsert loans:", JSON.stringify(error));
      return res.status(500).json({ 
        error: "Lỗi cơ sở dữ liệu", 
        message: error.message, 
        code: error.code,
        hint: error.hint || "Hãy đảm bảo bạn đã chạy SQL schema trong Supabase SQL Editor."
      });
    }
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      sanitizedLoans.forEach(l => {
        io.to(`user_${l.userId}`).emit("loan_updated", l);
      });
      io.to("admin").emit("loans_updated", sanitizedLoans);
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/loans:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/notifications", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const incomingNotifs = req.body;
    if (!Array.isArray(incomingNotifs)) {
      return res.status(400).json({ error: "Dữ liệu phải là mảng" });
    }

    const sanitizedNotifs = sanitizeData(incomingNotifs, NOTIFICATION_COLUMNS);
    if (sanitizedNotifs.length === 0) {
      return res.status(400).json({ error: "Không có dữ liệu hợp lệ để lưu" });
    }

    // Bulk upsert
    const { error } = await client.from('notifications').upsert(sanitizedNotifs, { onConflict: 'id' });
    if (error) {
      console.error("Lỗi upsert notifications:", JSON.stringify(error));
      return res.status(500).json({ 
        error: "Lỗi cơ sở dữ liệu", 
        message: error.message, 
        code: error.code,
        hint: error.hint || "Hãy đảm bảo bạn đã chạy SQL schema trong Supabase SQL Editor."
      });
    }
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      sanitizedNotifs.forEach(n => {
        io.to(`user_${n.userId}`).emit("notification_updated", n);
      });
      io.to("admin").emit("notifications_updated", sanitizedNotifs);
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/notifications:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/budget", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { budget } = req.body;
    const { error } = await client.from('config').upsert({ key: 'budget', value: budget }, { onConflict: 'key' });
    if (error) throw error;
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/budget:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/rankProfit", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { rankProfit } = req.body;
    const { error } = await client.from('config').upsert({ key: 'rankProfit', value: rankProfit }, { onConflict: 'key' });
    if (error) throw error;
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/rankProfit:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/loanProfit", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { loanProfit } = req.body;
    const { error } = await client.from('config').upsert({ key: 'loanProfit', value: loanProfit }, { onConflict: 'key' });
    if (error) throw error;
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/loanProfit:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/monthlyStats", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { monthlyStats } = req.body;
    const { error } = await client.from('config').upsert({ key: 'monthlyStats', value: monthlyStats }, { onConflict: 'key' });
    if (error) throw error;
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/monthlyStats:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const userId = req.params.id;
    await Promise.all([
      client.from('users').delete().eq('id', userId),
      client.from('loans').delete().eq('userId', userId),
      client.from('notifications').delete().eq('userId', userId)
    ]);
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong DELETE /api/users/:id:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// Helper to filter object keys based on allowed columns
const sanitizeData = (data: any[], allowedColumns: string[]) => {
  if (!Array.isArray(data)) return [];
  return data.map(item => {
    if (!item || typeof item !== 'object') return null;
    const sanitized: any = {};
    allowedColumns.forEach(col => {
      if (Object.prototype.hasOwnProperty.call(item, col)) {
        sanitized[col] = item[col];
      }
    });
    return sanitized;
  }).filter(item => item && item.id); // Ensure ID exists and item is not null
};

const USER_COLUMNS = [
  'id', 'phone', 'fullName', 'idNumber', 'balance', 'totalLimit', 'rank', 
  'rankProgress', 'isLoggedIn', 'isAdmin', 'pendingUpgradeRank', 
  'rankUpgradeBill', 'address', 'joinDate', 'idFront', 'idBack', 
  'refZalo', 'relationship', 'password', 'lastLoanSeq', 'bankName', 
  'bankAccountNumber', 'bankAccountHolder', 'hasJoinedZalo', 'updatedAt'
];

const USER_SUMMARY_COLUMNS = [
  'id', 'phone', 'fullName', 'idNumber', 'balance', 'totalLimit', 'rank', 
  'rankProgress', 'isLoggedIn', 'isAdmin', 'pendingUpgradeRank', 
  'address', 'joinDate', 'refZalo', 'relationship', 'lastLoanSeq', 'bankName', 
  'bankAccountNumber', 'bankAccountHolder', 'hasJoinedZalo', 'updatedAt'
];

const LOAN_COLUMNS = [
  'id', 'userId', 'userName', 'amount', 'date', 'createdAt', 'status', 
  'fine', 'billImage', 'bankTransactionId', 'signature', 'rejectionReason', 
  'settlementType', 'principalPaymentCount', 'updatedAt'
];

const LOAN_SUMMARY_COLUMNS = [
  'id', 'userId', 'userName', 'amount', 'date', 'createdAt', 'status', 
  'fine', 'bankTransactionId', 'rejectionReason', 
  'settlementType', 'principalPaymentCount', 'updatedAt'
];

const NOTIFICATION_COLUMNS = [
  'id', 'userId', 'title', 'message', 'time', 'read', 'type'
];

router.post("/sync", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { users, loans, notifications, budget, rankProfit, loanProfit, monthlyStats } = req.body;
    
    // Use a sequential approach for critical updates to prevent race conditions
    // and ensure data integrity under high load
    
    if (users && Array.isArray(users) && users.length > 0) {
      // Hash passwords for users in sync if they are not already hashed
      const processedUsers = await Promise.all(users.map(async (u) => {
        if (u.password && !u.password.startsWith('$2a$')) {
          const salt = await bcrypt.genSalt(10);
          u.password = await bcrypt.hash(u.password, salt);
        }
        return u;
      }));
      
      const sanitizedUsers = sanitizeData(processedUsers, USER_COLUMNS);
      if (sanitizedUsers.length > 0) {
        const { error } = await client.from('users').upsert(sanitizedUsers, { onConflict: 'id' });
        if (error) {
          console.error("[SYNC] Users upsert failed:", JSON.stringify(error));
          throw error;
        }
      }
    }
    
    if (loans && Array.isArray(loans) && loans.length > 0) {
      const sanitizedLoans = sanitizeData(loans, LOAN_COLUMNS);
      if (sanitizedLoans.length > 0) {
        const { error } = await client.from('loans').upsert(sanitizedLoans, { onConflict: 'id' });
        if (error) {
          console.error("[SYNC] Loans upsert failed:", JSON.stringify(error));
          // If it's a missing column error, try again without the new column
          if (error.code === '42703' || (error.message && error.message.includes('column "principalPaymentCount" does not exist'))) {
            console.warn("[SYNC] Retrying loans upsert without principalPaymentCount...");
            const fallbackColumns = LOAN_COLUMNS.filter(c => c !== 'principalPaymentCount');
            const saferLoans = sanitizeData(loans, fallbackColumns);
            const { error: retryError } = await client.from('loans').upsert(saferLoans, { onConflict: 'id' });
            if (retryError) throw retryError;
          } else {
            throw error;
          }
        }
      }
    }
    
    if (notifications && Array.isArray(notifications) && notifications.length > 0) {
      const sanitizedNotifications = sanitizeData(notifications, NOTIFICATION_COLUMNS);
      if (sanitizedNotifications.length > 0) {
        const { error } = await client.from('notifications').upsert(sanitizedNotifications, { onConflict: 'id' });
        if (error) {
          console.error("[SYNC] Notifications upsert failed:", JSON.stringify(error));
          throw error;
        }
      }
    }
    
    const configUpdates = [];
    if (budget !== undefined) configUpdates.push({ key: 'budget', value: budget });
    if (rankProfit !== undefined) configUpdates.push({ key: 'rankProfit', value: rankProfit });
    if (loanProfit !== undefined) configUpdates.push({ key: 'loanProfit', value: loanProfit });
    if (monthlyStats !== undefined) configUpdates.push({ key: 'monthlyStats', value: monthlyStats });
    
    if (configUpdates.length > 0) {
      const { error } = await client.from('config').upsert(configUpdates, { onConflict: 'key' });
      if (error) throw error;
    }
    
    // Emit real-time update
    const io = req.app.get("io");
    if (io) {
      if (users) users.forEach((u: any) => io.to(`user_${u.id}`).emit("user_updated", u));
      if (loans) loans.forEach((l: any) => io.to(`user_${l.userId}`).emit("loan_updated", l));
      if (notifications) notifications.forEach((n: any) => io.to(`user_${n.userId}`).emit("notification_updated", n));
      
      // Always notify admin of sync
      io.to("admin").emit("sync_completed", { users, loans, notifications, configUpdates });
      
      // If config changed, notify everyone or just admin? Usually budget affects everyone
      if (configUpdates.length > 0) {
        io.emit("config_updated", configUpdates);
      }
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/sync:", e);
    res.status(500).json({ 
      success: false,
      error: "Internal Server Error", 
      message: e.message || "Lỗi đồng bộ dữ liệu"
    });
  }
});

router.post("/reset", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    
    // Delete all data except admin
    await Promise.all([
      client.from('users').delete().neq('id', 'AD01'),
      client.from('loans').delete().neq('id', 'KEEP_NONE'),
      client.from('notifications').delete().neq('id', 'KEEP_NONE'),
      client.from('config').upsert({ key: 'budget', value: 30000000 }, { onConflict: 'key' }),
      client.from('config').upsert({ key: 'rankProfit', value: 0 }, { onConflict: 'key' }),
      client.from('config').upsert({ key: 'loanProfit', value: 0 }, { onConflict: 'key' }),
      client.from('config').upsert({ key: 'monthlyStats', value: [] }, { onConflict: 'key' })
    ]);
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/reset:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/migrate", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    
    console.log("[Migration] Attempting to add principalPaymentCount column...");
    
    // We use a raw SQL query via Supabase RPC if available, or we just try to insert a dummy record with the column
    // Since we can't easily run ALTER TABLE via the standard JS client without a custom RPC function,
    // we inform the user or try a workaround.
    
    // Most AI Studio apps have a 'exec_sql' or similar RPC if set up correctly, 
    // but here we'll just return instructions or try to detect if it exists.
    
    const { error } = await client.from('loans').select('principalPaymentCount').limit(1);
    
    if (error && (error.code === '42703' || error.message.includes('column "principalPaymentCount" does not exist'))) {
      return res.status(400).json({
        success: false,
        error: "Missing Column",
        message: "Cột 'principalPaymentCount' chưa tồn tại trong bảng 'loans'. Vui lòng truy cập Supabase SQL Editor và chạy lệnh: ALTER TABLE loans ADD COLUMN \"principalPaymentCount\" INTEGER DEFAULT 0;"
      });
    }
    
    res.json({ success: true, message: "Cấu trúc cơ sở dữ liệu đã chính xác." });
  } catch (e: any) {
    console.error("Lỗi trong /api/migrate:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

router.post("/import", async (req, res) => {
  try {
    const client = initSupabase();
    if (!client) return res.status(503).json({ error: "Supabase not configured" });
    const { users, loans, notifications, budget, rankProfit, loanProfit, monthlyStats } = req.body;
    
    // 1. Upsert users first to satisfy foreign key constraints in loans/notifications
    if (users && Array.isArray(users) && users.length > 0) {
      const sanitizedUsers = sanitizeData(users, USER_COLUMNS);
      if (sanitizedUsers.length > 0) {
        const { error: userError } = await client.from('users').upsert(sanitizedUsers, { onConflict: 'id' });
        if (userError) {
          console.error("Import users error:", JSON.stringify(userError));
          return res.status(500).json({ success: false, message: "Lỗi khi lưu danh sách người dùng", error: userError });
        }
      }
    }
    
    // 2. Upsert other data in parallel
    const tasks = [];
    
    if (loans && Array.isArray(loans) && loans.length > 0) {
      const sanitizedLoans = sanitizeData(loans, LOAN_COLUMNS);
      if (sanitizedLoans.length > 0) {
        tasks.push(client.from('loans').upsert(sanitizedLoans, { onConflict: 'id' }));
      }
    }
    
    if (notifications && Array.isArray(notifications) && notifications.length > 0) {
      const sanitizedNotifications = sanitizeData(notifications, NOTIFICATION_COLUMNS);
      if (sanitizedNotifications.length > 0) {
        tasks.push(client.from('notifications').upsert(sanitizedNotifications, { onConflict: 'id' }));
      }
    }
    
    if (budget !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'budget', value: budget }, { onConflict: 'key' }));
    }
    
    if (rankProfit !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'rankProfit', value: rankProfit }, { onConflict: 'key' }));
    }
 
    if (loanProfit !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'loanProfit', value: loanProfit }, { onConflict: 'key' }));
    }
 
    if (monthlyStats !== undefined) {
      tasks.push(client.from('config').upsert({ key: 'monthlyStats', value: monthlyStats }, { onConflict: 'key' }));
    }
    
    if (tasks.length > 0) {
      const results = await Promise.all(tasks);
      const errors = results.filter(r => r.error).map(r => r.error);
      
      if (errors.length > 0) {
        console.error("Import secondary data errors:", JSON.stringify(errors));
        return res.status(500).json({ success: false, message: "Lỗi khi lưu dữ liệu phụ trợ", errors });
      }
    }
    
    sendSafeJson(res, { success: true });
  } catch (e: any) {
    console.error("Lỗi trong /api/import:", e);
    res.status(500).json({ error: "Internal Server Error", message: e.message });
  }
});

// Specific health check for Vercel deployment verification
router.get("/api-health", (req, res) => {
  const client = initSupabase();
  res.json({ 
    status: "ok", 
    environment: process.env.NODE_ENV || 'production', 
    supabase: !!client,
    timestamp: new Date().toISOString(),
    url: req.url,
    method: req.method
  });
});

// Export the router
export { router as apiRouter };
export default app;
