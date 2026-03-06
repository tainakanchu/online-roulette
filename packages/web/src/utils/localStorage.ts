const isLocalStorageAvailable = () => {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch (error) {
    console.warn("Unable to access localStorage", error);
    return false;
  }
};

export const readLocalStorage = (key: string) => {
  if (!isLocalStorageAvailable()) {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    console.warn(`Failed to read "${key}" from localStorage`, error);
    return null;
  }
};

export const writeLocalStorage = (key: string, value: string) => {
  if (!isLocalStorageAvailable()) {
    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`Failed to write "${key}" to localStorage`, error);
  }
};
