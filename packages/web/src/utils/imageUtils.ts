import {
  COLORS,
  getColorBrightness,
  type GroupResult,
} from "@tainakanchu/roulette-core";
import { sortBattleRows, truncateLabel } from "./imageLayout";

export { sortBattleRows, truncateLabel } from "./imageLayout";
export type { BattleRow } from "./imageLayout";

export const generateRouletteResultImage = async (
  canvasElement: HTMLCanvasElement,
  resultText: string,
  resultLabel: string,
  language: string
): Promise<Blob> => {
  // 新しいキャンバスを作成して結果画像を生成
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Canvas context not available");
  }

  // キャンバスサイズを設定
  const width = 600;
  const height = 700;
  canvas.width = width;
  canvas.height = height;

  // 背景を白に設定
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  // タイトルを描画
  ctx.fillStyle = "#333333";
  ctx.font = "bold 32px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("🎯 Lucky Roulette", width / 2, 50);

  // ルーレット画像を描画
  const rouletteY = 80;
  const rouletteSize = 400;
  const rouletteX = (width - rouletteSize) / 2;

  ctx.drawImage(
    canvasElement,
    rouletteX,
    rouletteY,
    rouletteSize,
    rouletteSize
  );

  // 結果テキストの背景を描画
  const resultY = rouletteY + rouletteSize + 40;
  const resultBoxHeight = 120;
  const resultBoxY = resultY - 20;

  // 結果ボックスの背景
  ctx.fillStyle = "#f8f9fa";
  ctx.strokeStyle = "#dee2e6";
  ctx.lineWidth = 2;
  ctx.roundRect(50, resultBoxY, width - 100, resultBoxHeight, 10);
  ctx.fill();
  ctx.stroke();

  // "結果" ラベルを描画
  ctx.fillStyle = "#6c757d";
  ctx.font = "bold 20px sans-serif";
  ctx.fillText(resultLabel, width / 2, resultY + 10);

  // 結果テキストを描画
  ctx.fillStyle = "#212529";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(resultText, width / 2, resultY + 60);

  // 日時を描画
  const now = new Date();
  const dateString = now.toLocaleString(language);
  ctx.fillStyle = "#6c757d";
  ctx.font = "16px sans-serif";
  ctx.fillText(dateString, width / 2, height - 30);

  // キャンバスをBlobに変換
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        throw new Error("Failed to generate image blob");
      }
    }, "image/png");
  });
};

export const copyImageToClipboard = async (blob: Blob): Promise<void> => {
  try {
    const clipboardItem = new ClipboardItem({ "image/png": blob });
    await navigator.clipboard.write([clipboardItem]);
  } catch (error) {
    console.error("Failed to copy image to clipboard:", error);
    throw new Error("Failed to copy to clipboard");
  }
};

export const downloadImage = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/* =========================================================================
 * 共通ヘルパー
 * ========================================================================= */

/** キャンバスをPNGのBlobに変換する */
export const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to generate image blob"));
    }, "image/png");
  });

const IMAGE_WIDTH = 640;
const IMAGE_PADDING = 28;
const BG_TOP = "#1d0f3d";
const BG_BOTTOM = "#0f0820";
const ACCENT = "#FFD23F";
const TEXT_MAIN = "#ffffff";
const TEXT_SUB = "rgba(255, 255, 255, 0.6)";
const APP_TITLE = "🎯 Lucky Roulette";
const MEDALS = ["🥇", "🥈", "🥉"];

/** 2倍解像度のオフスクリーンキャンバスを作る */
const createScaledCanvas = (
  width: number,
  height: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas context not available");
  }
  ctx.scale(2, 2);
  return { canvas, ctx };
};

/** 背景（ダークパープルのグラデーション）を描画する */
const drawBackground = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void => {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, BG_TOP);
  gradient.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
};

/** ヘッダー（アプリ名 + サブタイトル）を描画する */
const drawHeader = (
  ctx: CanvasRenderingContext2D,
  width: number,
  subtitle: string
): void => {
  ctx.textAlign = "center";
  ctx.fillStyle = TEXT_MAIN;
  ctx.font = "bold 26px sans-serif";
  ctx.fillText(APP_TITLE, width / 2, 44);

  if (subtitle) {
    ctx.fillStyle = ACCENT;
    ctx.font = "bold 15px sans-serif";
    ctx.fillText(subtitle, width / 2, 70);
  }
};

/** フッター（日時）を描画する */
const drawFooter = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  language: string
): void => {
  ctx.textAlign = "center";
  ctx.fillStyle = TEXT_SUB;
  ctx.font = "14px sans-serif";
  ctx.fillText(new Date().toLocaleString(language), width / 2, height - 20);
};

/** キャンバス上で幅に収まるように切り詰める */
const fitText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string => truncateLabel(text, maxWidth, (value) => ctx.measureText(value).width);

/* =========================================================================
 * バトルモードの結果画像
 * ========================================================================= */

export interface BattleImageLabels {
  /** 画像上部のサブタイトル */
  title: string;
  /** 勝者カードのラベル（翻訳側に🏆が含まれる） */
  winnerLabel: string;
  /** 抽選回数のラベル */
  drawsLabel: string;
}

const BATTLE_MAX_ROWS = 30;
const BATTLE_ROW_STEP = 38;
const BATTLE_BAR_HEIGHT = 22;
const BATTLE_LABEL_X = IMAGE_PADDING + 28;
const BATTLE_LABEL_WIDTH = 180;
const BATTLE_BAR_X = BATTLE_LABEL_X + BATTLE_LABEL_WIDTH + 12;
const BATTLE_COUNT_WIDTH = 64;

export const generateBattleResultImage = ({
  options,
  counts,
  winner,
  drawCount,
  labels,
  language,
}: {
  options: string[];
  counts: number[];
  winner: string;
  drawCount: number;
  labels: BattleImageLabels;
  language: string;
}): Promise<Blob> => {
  const sorted = sortBattleRows(options, counts);
  const rows = sorted.slice(0, BATTLE_MAX_ROWS);
  const hiddenCount = sorted.length - rows.length;

  const headerHeight = 96;
  const rowsHeight = rows.length * BATTLE_ROW_STEP + (hiddenCount > 0 ? 26 : 0);
  const winnerCardHeight = 96;
  const footerHeight = 46;
  const width = IMAGE_WIDTH;
  const height =
    headerHeight + rowsHeight + 18 + winnerCardHeight + footerHeight;

  const { canvas, ctx } = createScaledCanvas(width, height);

  drawBackground(ctx, width, height);
  drawHeader(ctx, width, labels.title);

  // 抽選回数
  ctx.textAlign = "center";
  ctx.fillStyle = TEXT_SUB;
  ctx.font = "13px sans-serif";
  ctx.fillText(
    `${labels.drawsLabel} ${drawCount.toLocaleString(language)}`,
    width / 2,
    90
  );

  const maxCount = rows.reduce((max, row) => Math.max(max, row.count), 0);
  const barMaxWidth =
    width - IMAGE_PADDING - BATTLE_COUNT_WIDTH - BATTLE_BAR_X - 8;

  rows.forEach((row, i) => {
    const y = headerHeight + i * BATTLE_ROW_STEP;
    const isWinner = row.label === winner;
    const centerY = y + BATTLE_BAR_HEIGHT / 2 + 5;

    // メダル（上位3件）
    if (i < MEDALS.length) {
      ctx.textAlign = "left";
      ctx.font = "16px sans-serif";
      ctx.fillText(MEDALS[i], IMAGE_PADDING, centerY);
    }

    // ラベル
    ctx.textAlign = "left";
    ctx.fillStyle = isWinner ? ACCENT : TEXT_MAIN;
    ctx.font = isWinner ? "bold 15px sans-serif" : "15px sans-serif";
    ctx.fillText(
      fitText(ctx, row.label, BATTLE_LABEL_WIDTH),
      BATTLE_LABEL_X,
      centerY
    );

    // バーの背景
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.beginPath();
    ctx.roundRect(BATTLE_BAR_X, y, barMaxWidth, BATTLE_BAR_HEIGHT, 11);
    ctx.fill();

    // バー本体
    const ratio = maxCount > 0 ? row.count / maxCount : 0;
    const barWidth = Math.max(ratio * barMaxWidth, row.count > 0 ? 6 : 0);
    if (barWidth > 0) {
      ctx.fillStyle = COLORS[row.index % COLORS.length];
      ctx.beginPath();
      ctx.roundRect(BATTLE_BAR_X, y, barWidth, BATTLE_BAR_HEIGHT, 11);
      ctx.fill();
    }

    // 当選回数
    ctx.textAlign = "right";
    ctx.fillStyle = isWinner ? ACCENT : TEXT_MAIN;
    ctx.font = isWinner ? "bold 15px sans-serif" : "15px sans-serif";
    ctx.fillText(row.count.toLocaleString(language), width - IMAGE_PADDING, centerY);
  });

  if (hiddenCount > 0) {
    ctx.textAlign = "left";
    ctx.fillStyle = TEXT_SUB;
    ctx.font = "14px sans-serif";
    ctx.fillText(
      `+${hiddenCount}`,
      BATTLE_LABEL_X,
      headerHeight + rows.length * BATTLE_ROW_STEP + 14
    );
  }

  // 勝者カード
  const cardY = headerHeight + rowsHeight + 18;
  const cardX = IMAGE_PADDING;
  const cardWidth = width - IMAGE_PADDING * 2;
  ctx.fillStyle = "rgba(255, 210, 63, 0.16)";
  ctx.strokeStyle = "rgba(255, 210, 63, 0.45)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, winnerCardHeight, 16);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = ACCENT;
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(labels.winnerLabel, width / 2, cardY + 30);

  ctx.fillStyle = TEXT_MAIN;
  ctx.font = "bold 30px sans-serif";
  ctx.fillText(fitText(ctx, winner, cardWidth - 40), width / 2, cardY + 72);

  drawFooter(ctx, width, height, language);

  return canvasToBlob(canvas);
};

/* =========================================================================
 * グループ分けの結果画像
 * ========================================================================= */

export interface GroupImageLabels {
  /** 画像上部のサブタイトル */
  title: string;
  /** 「n人」のようなメンバー数表記 */
  membersLabel: (count: number) => string;
}

const GROUP_HEADER_HEIGHT = 40;
const GROUP_MEMBER_HEIGHT = 26;
const GROUP_CARD_GAP = 16;
const GROUP_LIST_PADDING = 10;

export const generateGroupResultImage = ({
  groups,
  labels,
  language,
}: {
  groups: GroupResult[];
  labels: GroupImageLabels;
  language: string;
}): Promise<Blob> => {
  const columns = groups.length <= 1 ? 1 : 2;
  const width = IMAGE_WIDTH;
  const cardWidth =
    (width - IMAGE_PADDING * 2 - GROUP_CARD_GAP * (columns - 1)) / columns;

  const cardHeight = (group: GroupResult): number =>
    GROUP_HEADER_HEIGHT +
    GROUP_LIST_PADDING * 2 +
    Math.max(group.items.length, 1) * GROUP_MEMBER_HEIGHT;

  // 行ごとの高さ（その行で一番高いカードに揃える）
  const rowHeights: number[] = [];
  for (let i = 0; i < groups.length; i += columns) {
    const row = groups.slice(i, i + columns);
    rowHeights.push(row.reduce((max, g) => Math.max(max, cardHeight(g)), 0));
  }

  const headerHeight = 96;
  const footerHeight = 46;
  const gridHeight =
    rowHeights.reduce((sum, h) => sum + h, 0) +
    Math.max(rowHeights.length - 1, 0) * GROUP_CARD_GAP;
  const height = headerHeight + gridHeight + footerHeight;

  const { canvas, ctx } = createScaledCanvas(width, height);

  drawBackground(ctx, width, height);
  drawHeader(ctx, width, labels.title);

  groups.forEach((group, index) => {
    const rowIndex = Math.floor(index / columns);
    const colIndex = index % columns;
    const x = IMAGE_PADDING + colIndex * (cardWidth + GROUP_CARD_GAP);
    const y =
      headerHeight +
      rowHeights
        .slice(0, rowIndex)
        .reduce((sum, h) => sum + h + GROUP_CARD_GAP, 0);
    const currentHeight = rowHeights[rowIndex];

    // カード（角丸でクリップしてからヘッダー/本体を塗る）
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, cardWidth, currentHeight, 14);
    ctx.clip();

    ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
    ctx.fillRect(x, y, cardWidth, currentHeight);
    ctx.fillStyle = group.color;
    ctx.fillRect(x, y, cardWidth, GROUP_HEADER_HEIGHT);
    ctx.restore();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, cardWidth, currentHeight, 14);
    ctx.stroke();

    // ヘッダーのテキスト
    const headerTextColor =
      getColorBrightness(group.color) > 128 ? "#1a1330" : "#ffffff";
    const memberText = labels.membersLabel(group.items.length);
    ctx.font = "12px sans-serif";
    const memberTextWidth = ctx.measureText(memberText).width;

    ctx.textAlign = "left";
    ctx.fillStyle = headerTextColor;
    ctx.font = "bold 15px sans-serif";
    ctx.fillText(
      fitText(ctx, group.label, cardWidth - 28 - memberTextWidth - 10),
      x + 14,
      y + 26
    );

    ctx.textAlign = "right";
    ctx.font = "12px sans-serif";
    ctx.fillText(memberText, x + cardWidth - 14, y + 26);

    // メンバー一覧
    ctx.textAlign = "left";
    ctx.font = "14px sans-serif";
    group.items.forEach((item, i) => {
      const itemY =
        y +
        GROUP_HEADER_HEIGHT +
        GROUP_LIST_PADDING +
        i * GROUP_MEMBER_HEIGHT +
        18;

      if (i > 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
        ctx.fillRect(x + 14, itemY - 19, cardWidth - 28, 1);
      }

      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.fillText(fitText(ctx, item, cardWidth - 28), x + 14, itemY);
    });
  });

  drawFooter(ctx, width, height, language);

  return canvasToBlob(canvas);
};
