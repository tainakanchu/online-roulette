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
  duration = 3000,
}) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (isVisible) {
      setIsExiting(false);
      const timer = setTimeout(() => {
        setIsExiting(true);
        setTimeout(onClose, 300); // フェードアウトアニメーションの時間
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [isVisible, duration, onClose]);

  if (!isVisible && !isExiting) return null;

  return (
    <div className={`snackbar ${isExiting ? "exiting" : ""}`}>
      <div className="snackbar-content">
        <span>{message}</span>
        <button className="snackbar-close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
};
