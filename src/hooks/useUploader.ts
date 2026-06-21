import { useCallback, useEffect, useRef, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { LocationSample } from '../core/uploadTypes';
import { HttpUploadClient } from '../core/uploadClient';
import { BatchUploader } from '../core/batchUploader';
import { RetryController, DEFAULT_BACKOFF_CONFIG } from '../core/retryController';
import { UploadQueue, createDefaultUploadQueue } from '../storage/uploadQueue';
import { loadUploadConfig, saveUploadConfig } from '../storage/uploadConfigStore';

interface UploaderConfig {
  baseUrl: string;
  path: string;
  token: string;
  batchSize: number;
  flushIntervalMs: number;
}

export interface UploaderStatus {
  uploadEnabled: boolean;
  isOnline: boolean;
  pendingCount: number;
  lastSentAt: Date | null;
  authError: number | null;
}

export interface UseUploaderReturn extends UploaderStatus {
  enqueue: (sample: LocationSample) => Promise<void>;
  toggleUpload: () => Promise<void>;
}

export function useUploader(): UseUploaderReturn {
  const [uploadEnabled, setUploadEnabled] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSentAt, setLastSentAt] = useState<Date | null>(null);
  const [authError, setAuthError] = useState<number | null>(null);
  const [config, setConfig] = useState<UploaderConfig | null>(null);

  const queueRef = useRef<UploadQueue>(createDefaultUploadQueue());
  const uploaderRef = useRef<BatchUploader | null>(null);
  const retryRef = useRef<RetryController | null>(null);
  const prevOnlineRef = useRef<boolean | null>(null);
  const uploadEnabledRef = useRef<boolean>(false);
  uploadEnabledRef.current = uploadEnabled;

  // Load persisted config once on mount
  useEffect(() => {
    loadUploadConfig().then(cfg => {
      setConfig({
        baseUrl: cfg.baseUrl,
        path: cfg.path,
        token: cfg.token,
        batchSize: cfg.batchSize,
        flushIntervalMs: cfg.flushIntervalMs,
      });
      setUploadEnabled(cfg.uploadEnabled);
    });
  }, []);

  const refreshCount = useCallback(async () => {
    const n = await queueRef.current.count();
    setPendingCount(n);
  }, []);

  // Single NetInfo subscription: tracks isOnline and triggers flush on reconnect
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state: NetInfoState) => {
      const online = state.isConnected === true && state.isInternetReachable !== false;
      setIsOnline(online);
      if (prevOnlineRef.current === false && online) {
        retryRef.current?.onConnectivityRestored();
      }
      prevOnlineRef.current = online;
    });
    return unsub;
  }, []);

  // Build / tear down upload pipeline whenever config or enabled flag changes
  useEffect(() => {
    if (!config || !uploadEnabled || !config.baseUrl || !config.token) {
      uploaderRef.current?.stop();
      retryRef.current?.destroy();
      uploaderRef.current = null;
      retryRef.current = null;
      return;
    }

    const client = new HttpUploadClient({
      baseUrl: config.baseUrl,
      path: config.path,
      token: config.token,
    });

    const uploader = new BatchUploader(queueRef.current, client, {
      batchSize: config.batchSize,
      flushIntervalMs: config.flushIntervalMs,
    });

    const retry = new RetryController(uploader, DEFAULT_BACKOFF_CONFIG, (status) => {
      setAuthError(status);
    });

    uploader.setListener(event => {
      retry.handleEvent(event);
      if (event.type === 'success') {
        setLastSentAt(new Date());
        setAuthError(prev => (prev !== null ? null : prev));
      }
      refreshCount();
    });

    uploaderRef.current = uploader;
    retryRef.current = retry;
    uploader.start();
    refreshCount();

    return () => {
      uploader.stop();
      retry.destroy();
      uploaderRef.current = null;
      retryRef.current = null;
    };
  }, [config, uploadEnabled, refreshCount]);

  const enqueue = useCallback(async (sample: LocationSample) => {
    await queueRef.current.enqueue(sample);
    await refreshCount();
    await uploaderRef.current?.onEnqueue();
  }, [refreshCount]);

  const toggleUpload = useCallback(async () => {
    const next = !uploadEnabledRef.current;
    uploadEnabledRef.current = next;
    setUploadEnabled(next);
    await saveUploadConfig({ uploadEnabled: next });
  }, []);

  return { uploadEnabled, isOnline, pendingCount, lastSentAt, authError, enqueue, toggleUpload };
}
