import { useState, type FC } from "react";
import { useTranslation } from "react-i18next";
import type { GroupResult } from "@tainakanchu/roulette-core";
import {
  generateGroupResultImage,
  copyImageToClipboard,
  downloadImage,
} from "../utils/imageUtils";

interface GroupActionsProps {
  groups: GroupResult[];
  onSuccess: (message: string) => void;
}

const buildFilename = (): string => {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `grouping-result-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;
};

export const GroupActions: FC<GroupActionsProps> = ({ groups, onSuccess }) => {
  const { t, i18n } = useTranslation();
  const [isGenerating, setIsGenerating] = useState(false);

  const generate = async (): Promise<Blob> => {
    return generateGroupResultImage(
      groups,
      "🎯 Lucky Roulette",
      t("grouping.resultTitle"),
      i18n.language
    );
  };

  const handleCopy = async () => {
    if (groups.length === 0) return;
    setIsGenerating(true);
    try {
      const blob = await generate();
      await copyImageToClipboard(blob);
      onSuccess(t("actions.copySuccess"));
    } catch (error) {
      console.error("Error copying group result:", error);
      onSuccess(t("actions.copyError"));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (groups.length === 0) return;
    setIsGenerating(true);
    try {
      const blob = await generate();
      downloadImage(blob, buildFilename());
      onSuccess(t("actions.downloadSuccess"));
    } catch (error) {
      console.error("Error downloading group result:", error);
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
