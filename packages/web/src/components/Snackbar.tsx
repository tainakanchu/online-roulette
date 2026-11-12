import { useEffect, useState } from "react";
import "../styles/components/Snackbar.css";

interface SnackbarProps {
  message: string;
  isVisible: boolean;
  onClose: () => void;
  duration?: number;
}

export const Snackbar: React.FC<SnackbarProps> = ({
  message,
  isVisible,
  onClose,
  duration = 2500,
}) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (isVisible) {
      setIsExiting(false);
      let closeTimer: ReturnType<typeof setTimeout>;
      const timer = setTimeout(() => {
        setIsExiting(true);
        closeTimer = setTimeout(onClose, 300); // フェードアウトアニメーションの時間
      }, duration);
      return () => {
        clearTimeout(timer);
        clearTimeout(closeTimer);
      };
    }
  }, [isVisible, duration, onClose]);

  if (!isVisible) return null;

  return (
    <div className={`snackbar ${isExiting ? "exiting" : ""}`}>
      <span className="snackbar-message">{message}</span>
    </div>
  );
};
