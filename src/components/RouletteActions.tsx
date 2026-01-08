import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  generateRouletteResultImage,
  copyImageToClipboard,
  downloadImage,
} from "../utils/imageUtils";

interface RouletteActionsProps {
  canvasElement: HTMLCanvasElement | null;
  currentOption: string;
  isVisible: boolean;
  onSuccess: (message: string) => void;
}

export const RouletteActions: React.FC<RouletteActionsProps> = ({
  canvasElement,
  currentOption,
  isVisible,
  onSuccess,
}) => {
  const { t, i18n } = useTranslation();
  const [isGenerating, setIsGenerating] = useState(false);

  const handleCopyToClipboard = async () => {
    if (!currentOption || !canvasElement) return;

    setIsGenerating(true);
    try {
      const imageBlob = await generateRouletteResultImage(
        canvasElement,
        currentOption,
        t("result.label"),
        i18n.language
      );
      await copyImageToClipboard(imageBlob);
      onSuccess(t("actions.copySuccess"));
    } catch (error) {
      console.error("Error copying to clipboard:", error);
      onSuccess(t("actions.copyError"));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!currentOption || !canvasElement) return;

    setIsGenerating(true);
    try {
      const imageBlob = await generateRouletteResultImage(
        canvasElement,
        currentOption,
        t("result.label"),
        i18n.language
      );
      const now = new Date();
      const filename = `roulette-result-${now.getFullYear()}${(
        now.getMonth() + 1
      )
        .toString()
        .padStart(2, "0")}${now.getDate().toString().padStart(2, "0")}-${now
        .getHours()
        .toString()
        .padStart(2, "0")}${now.getMinutes().toString().padStart(2, "0")}.png`;
      downloadImage(imageBlob, filename);
      onSuccess(t("actions.downloadSuccess"));
    } catch (error) {
      console.error("Error downloading image:", error);
      onSuccess(t("actions.downloadError"));
    } finally {
      setIsGenerating(false);
    }
  };

  if (!isVisible) return null;

  return (
    <div className="roulette-actions">
      <button
        onClick={handleCopyToClipboard}
        disabled={isGenerating}
        className="action-button copy-action"
        title={t("actions.copyTitle")}
      >
        📋
      </button>
      <button
        onClick={handleDownload}
        disabled={isGenerating}
        className="action-button download-action"
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
