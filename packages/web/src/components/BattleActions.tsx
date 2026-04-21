import { useState, type FC } from "react";
import { useTranslation } from "react-i18next";
import { COLORS } from "@tainakanchu/roulette-core";
import {
  generateBattleResultImage,
  copyImageToClipboard,
  downloadImage,
} from "../utils/imageUtils";

interface BattleActionsProps {
  options: string[];
  counts: number[];
  winner: string;
  onSuccess: (message: string) => void;
}

const buildFilename = (): string => {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `battle-result-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
};

export const BattleActions: FC<BattleActionsProps> = ({
  options,
  counts,
  winner,
  onSuccess,
}) => {
  const { t, i18n } = useTranslation();
  const [isGenerating, setIsGenerating] = useState(false);

  const generate = async (): Promise<Blob> => {
    const entries = options
      .map((label, index) => ({
        label,
        count: counts[index] ?? 0,
        color: COLORS[index % COLORS.length],
      }))
      .sort((a, b) => b.count - a.count);
    return generateBattleResultImage(
      entries,
      winner,
      "🎯 Lucky Roulette",
      t("battle.winner"),
      i18n.language
    );
  };

  const handleCopy = async () => {
    if (!winner) return;
    setIsGenerating(true);
    try {
      const blob = await generate();
      await copyImageToClipboard(blob);
      onSuccess(t("actions.copySuccess"));
    } catch (error) {
      console.error("Error copying battle result:", error);
      onSuccess(t("actions.copyError"));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!winner) return;
    setIsGenerating(true);
    try {
      const blob = await generate();
      downloadImage(blob, buildFilename());
      onSuccess(t("actions.downloadSuccess"));
    } catch (error) {
      console.error("Error downloading battle result:", error);
      onSuccess(t("actions.downloadError"));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="result-actions-inline">
      <button
        type="button"
        onClick={handleCopy}
        disabled={isGenerating}
        className="action-button"
        title={t("actions.copyTitle")}
      >
        📋
      </button>
      <button
        type="button"
        onClick={handleDownload}
        disabled={isGenerating}
        className="action-button"
        title={t("actions.downloadTitle")}
      >
        💾
      </button>
      {isGenerating && (
        <div className="generating-indicator">
          <div className="spinner"></div>
        </div>
      )}
    </div>
  );
};
