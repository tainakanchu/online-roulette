import { useState, useCallback } from "react";

interface UseSnackbarReturn {
  isVisible: boolean;
  message: string;
  showSnackbar: (message: string) => void;
  hideSnackbar: () => void;
}

export const useSnackbar = (): UseSnackbarReturn => {
  const [isVisible, setIsVisible] = useState(false);
  const [message, setMessage] = useState("");

  const showSnackbar = useCallback((newMessage: string) => {
    setMessage(newMessage);
    setIsVisible(true);
  }, []);

  const hideSnackbar = useCallback(() => {
    setIsVisible(false);
  }, []);

  return {
    isVisible,
    message,
    showSnackbar,
    hideSnackbar,
  };
};
