import type { SkipReason } from './types';

/** Lý do bỏ qua bản tin ở chặng dịch tenant — nhãn tiếng Việt + giải thích ngắn. */
export const SKIP_REASONS: Record<
  SkipReason,
  { label: string; help: string; tone: 'critical' | 'warn' | 'muted' }
> = {
  parse_failed: {
    label: 'Sai định dạng',
    help: 'Không đọc được bản tin. Tăng đột biến thường do tenant đổi API — cần kiểm tra ngay.',
    tone: 'critical',
  },
  unsupported_sport: {
    label: 'Môn không hỗ trợ',
    help: 'Bản tin thuộc môn chưa có ánh xạ giữa hai nguồn. Kiểm tra bảng môn hỗ trợ.',
    tone: 'muted',
  },
  unsupported_event: {
    label: 'Bản tin bổ sung',
    help: 'Giá giao dịch cuối, thay đổi bước giá hoặc thông báo market mới. Không dùng để cập nhật odds.',
    tone: 'muted',
  },
  invalid_event: {
    label: 'Sự kiện không hợp lệ',
    help: 'Thiếu id trận, giờ bắt đầu hoặc đội không hợp lệ.',
    tone: 'warn',
  },
  unsupported_market: {
    label: 'Market không hỗ trợ',
    help: 'Loại cược hệ thống chưa ghép (ví dụ cược phụ). Bình thường, chiếm phần lớn.',
    tone: 'muted',
  },
  unsupported_line: {
    label: 'Mốc không hỗ trợ',
    help: 'Đúng loại market nhưng mốc chấp/tổng nằm ngoài danh sách.',
    tone: 'muted',
  },
  missing_fields: {
    label: 'Thiếu trường',
    help: 'Bản tin thiếu trường bắt buộc (odds, outcome…).',
    tone: 'warn',
  },
  same_team_names: {
    label: 'Trùng tên hai đội',
    help: 'Hai đội chuẩn hóa ra cùng một tên — không tạo được room.',
    tone: 'warn',
  },
  no_moneyline_teams: {
    label: 'Không xác định được đội',
    help: 'Không tìm thấy tên đội từ market thắng trận.',
    tone: 'warn',
  },
  unknown_asset: {
    label: 'Token lạ',
    help: 'Polymarket gửi giá của token chưa có trong descriptor. Tăng nhiều → descriptor chậm.',
    tone: 'warn',
  },
};

export const SKIP_ORDER = Object.keys(SKIP_REASONS) as SkipReason[];

/** Lý do hủy kèo. */
export const CANCEL_REASONS: Record<string, string> = {
  below_threshold: 'Lợi nhuận dưới ngưỡng',
  better_opportunity: 'Có kèo tốt hơn',
  margin_decreased: 'Kèo không còn tốt nữa',
  leg_suspended: 'Một chân bị khóa odds',
  leg_removed: 'Một chân bị gỡ',
  start_time_mismatch: 'Lệch giờ bắt đầu',
  publisher_stopped: 'Publisher đã dừng',
  phase_disabled: 'Kênh bị tắt',
  match_expired: 'Trận đã kết thúc',
  missing_from_listing: 'Không còn trong danh sách',
  app_restart: 'App khởi động lại',
};
