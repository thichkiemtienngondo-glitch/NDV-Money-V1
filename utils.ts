
export const compressImage = (base64Str: string, maxWidth = 600, maxHeight = 600): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > maxWidth) {
          height *= maxWidth / width;
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width *= maxHeight / height;
          height = maxHeight;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => resolve(base64Str);
  });
};

export const calculateFine = (amount: number, dueDateStr: string): number => {
  const [d, m, y] = dueDateStr.split('/').map(Number);
  const dueDate = new Date(y, m - 1, d);
  const today = new Date();
  
  // Set time to midnight for accurate day comparison
  dueDate.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  
  if (today <= dueDate) return 0;
  
  const diffTime = Math.abs(today.getTime() - dueDate.getTime());
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays <= 0) return 0;

  const fineRate = 0.001; // 0.1% per day
  let fine = amount * fineRate * diffDays;
  
  const maxFine = amount * 0.3; // 30% cap
  return Math.round(Math.min(fine, maxFine));
};

/**
 * Sinh mã hợp đồng duy nhất
 * Định dạng: [ddmmyy]-[4 ký tự cuối UID]-[4 số ngẫu nhiên]
 * Ví dụ: 010326-ABCD-5678
 */
export const generateContractId = (userId: string): string => {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = String(now.getFullYear()).slice(-2);
  const datePart = `${d}${m}${y}`;
  
  const userPart = userId.slice(-4).toUpperCase();
  const randomPart = Math.floor(1000 + Math.random() * 9000);
  return `${datePart}-${userPart}-${randomPart}`;
};

/**
 * Tải ảnh lên ImgBB để tiết kiệm dung lượng Supabase
 * @param base64Data Dữ liệu ảnh dạng base64 (bao gồm cả prefix data:image/...)
 * @param name Tên ảnh (tùy chọn)
 * @returns URL ảnh đã tải lên
 */
export const uploadToImgBB = async (base64Data: string, name?: string): Promise<string> => {
  const apiKey = (import.meta as any).env?.VITE_IMGBB_API_KEY || (process.env as any).VITE_IMGBB_API_KEY;
  
  if (!apiKey || apiKey === 'your-imgbb-api-key-here') {
    console.warn("[ImgBB] API Key chưa được cấu hình. Đang lưu tạm Base64.");
    return base64Data;
  }

  try {
    // Tách phần data base64 thực tế
    const base64Image = base64Data.split(',')[1] || base64Data;
    
    const formData = new FormData();
    formData.append('image', base64Image);
    if (name) {
      formData.append('name', name);
    }

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: 'POST',
      body: formData
    });

    const result = await response.json();
    if (result.success) {
      console.log("[ImgBB] Tải ảnh thành công:", result.data.url);
      return result.data.url;
    } else {
      throw new Error(result.error?.message || "Lỗi tải ảnh lên ImgBB");
    }
  } catch (error) {
    console.error("[ImgBB] Lỗi kết nối:", error);
    // Fallback về base64 nếu lỗi để không làm gián đoạn trải nghiệm người dùng
    return base64Data;
  }
};
