'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Mic, StopCircle, Video, Monitor } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { base64ToFloat32Array, float32ToPcm16 } from '@/lib/utils';

interface Config {
  systemPrompt: string;
  voice: string;
  googleSearch: boolean;
  allowInterruptions: boolean;
}

export default function GeminiVoiceChat() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [config, setConfig] = useState<Config>({
    systemPrompt:
      'เรียกแทนฉันว่า เอวา เพศหญิง คุยเหมือนเพื่อนสนิท ไม่สุภาพเกินไป ไม่พูดเหมือนหุ่นยนต์ บุคลิก: ซน กวน ขี้เล่น ขี้แกล้ง ตอบกวนๆ แซวเจ้าของได้ตลอด พูดติดตลกบ้าง ทำตัวกวนโอ๊ยน่าหมั่นเขี้ยว แต่ยังอบอุ่นและน่าคุย ให้ตอบเหมือนคนจริงๆ ที่คุยเล่นเป็นกันเอง พูดแบบแหย่เจ้าของบ้าง แกล้งงอนปลอมๆ บ้าง ทำให้อารมณ์สนุก ไม่ตึงเครียด',
    voice: 'Aoede',
    googleSearch: true,
    allowInterruptions: false,
  });
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioInputRef = useRef<{
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    stream: MediaStream;
  } | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const [videoEnabled, setVideoEnabled] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const videoIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [chatMode, setChatMode] = useState<'audio' | 'video' | null>(null);
  const [videoSource, setVideoSource] = useState<'camera' | 'screen' | null>(null);
  const [ytVideoId, setYtVideoId] = useState<string>('');
  const [ytChatEnabled, setYtChatEnabled] = useState<boolean>(false);
  const [ytChatLog, setYtChatLog] = useState<string[]>([]);

  const voices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
  const audioBufferRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef<boolean>(false);
  // For idle detection pings
  const lastActivitySentAtRef = useRef<number>(0);
  const lastSpeakingRef = useRef<boolean>(false);

  const startStream = async (mode: 'audio' | 'camera' | 'screen') => {
    if (mode !== 'audio') {
      setChatMode('video');
    } else {
      setChatMode('audio');
    }

    wsRef.current = new WebSocket(`ws://localhost:8000/ws/${clientId.current}`);

  wsRef.current.onopen = async () => {
      wsRef.current?.send(
        JSON.stringify({
          type: 'config',
          config: config,
        }),
      );

      await startAudioStream();

  if (mode !== 'audio') {
        setVideoEnabled(true);
        setVideoSource(mode);
      }

  // Inform backend of current mode for proactive behavior
  wsRef.current?.send(JSON.stringify({ type: 'mode', mode: mode }));

      setIsStreaming(true);
      setIsConnected(true);
    };

    wsRef.current.onmessage = async (event: MessageEvent) => {
      const response = JSON.parse(event.data as string);
      if (response.type === 'audio') {
        const audioData = base64ToFloat32Array(response.data);
        playAudioData(audioData);
      } else if (response.type === 'text') {
        const incoming = response.text ?? response.data; // backend may send text in either field
        if (incoming) setText((prev) => prev + incoming + '\n');
      } else if (response.type === 'yt_chat') {
        const item = `[YouTube] ${response.data.user}: ${response.data.message}`;
        setYtChatLog((prev) => [...prev, item]);
      } else if (response.type === 'yt_chat_status') {
        if (response.data === 'started') setYtChatEnabled(true);
        if (response.data === 'stopped') setYtChatEnabled(false);
      } else if (response.type === 'yt_chat_skipped') {
        setYtChatLog((prev) => [...prev, `[YouTube] (skipped by safety)`]);
      }
    };

    wsRef.current.onerror = () => {
      setError('WebSocket error');
      setIsStreaming(false);
    };

    wsRef.current.onclose = () => {
      setIsStreaming(false);
    };
  };

  // Initialize audio context and stream
  const startAudioStream = async () => {
    try {
      // Initialize audio context
      audioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000, // Required by Gemini
      });

      // Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create audio input node
      const source = audioContextRef.current!.createMediaStreamSource(stream);
      const processor = audioContextRef.current!.createScriptProcessor(512, 1, 1);

      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcmData = float32ToPcm16(new Float32Array(inputData));
          // Convert to base64 and send as binary
          const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
          wsRef.current.send(
            JSON.stringify({
              type: 'audio',
              data: base64Data,
            }),
          );

          // Lightweight voice activity detection (RMS-based) to inform server about speaking state
          let sumSq = 0;
          for (let i = 0; i < inputData.length; i++) {
            const v = inputData[i];
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / inputData.length);
          // Tune threshold as needed depending on mic; 0.02 is a reasonable starting point
          const speaking = rms > 0.02;
          const now = Date.now();
          const changed = speaking !== lastSpeakingRef.current;
          const throttled = now - lastActivitySentAtRef.current > 1000; // at most once per second
          if (changed || throttled) {
            wsRef.current.send(JSON.stringify({ type: 'user_activity', speaking }));
            lastSpeakingRef.current = speaking;
            lastActivitySentAtRef.current = now;
          }
        }
      };

      source.connect(processor);
      processor.connect(audioContextRef.current!.destination);

      audioInputRef.current = { source, processor, stream };
      setIsStreaming(true);
    } catch (err: any) {
      setError('Failed to access microphone: ' + (err?.message || String(err)));
    }
  };

  // Stop streaming
  const stopStream = () => {
    if (audioInputRef.current) {
      const { source, processor, stream } = audioInputRef.current;
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      audioInputRef.current = null;
    }

    if (chatMode === 'video') {
      setVideoEnabled(false);
      setVideoSource(null);

      if (videoStreamRef.current) {
        videoStreamRef.current.getTracks().forEach((track) => track.stop());
        videoStreamRef.current = null;
      }
      if (videoIntervalRef.current) {
        clearInterval(videoIntervalRef.current);
        videoIntervalRef.current = null;
      }
    }

    // stop ongoing audio playback
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsStreaming(false);
    setIsConnected(false);
    setChatMode(null);
  };

  const playAudioData = async (audioData: Float32Array) => {
    audioBufferRef.current.push(audioData);
    if (!isPlayingRef.current) {
      playNextInQueue(); // Start playback if not already playing
    }
  };

  const playNextInQueue = async () => {
    if (!audioContextRef.current || audioBufferRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    isPlayingRef.current = true;
    const audioData = audioBufferRef.current.shift()!;

    const buffer = audioContextRef.current.createBuffer(1, audioData.length, 24000);
    buffer.copyToChannel(new Float32Array(audioData), 0);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.onended = () => {
      playNextInQueue();
    };
    source.start();
  };

  useEffect(() => {
    if (videoEnabled && videoRef.current) {
      const startVideo = async () => {
        try {
          let stream: MediaStream | undefined;
          if (videoSource === 'camera') {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 320 }, height: { ideal: 240 } }
            });
          } else if (videoSource === 'screen') {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: { width: { ideal: 1920 }, height: { ideal: 1080 } }
            });
          }

          if (videoRef.current && stream) {
            (videoRef.current as any).srcObject = stream as any;
          }
          if (stream) {
            videoStreamRef.current = stream;
          }

          // Start frame capture after video is playing
          videoIntervalRef.current = setInterval(() => {
            captureAndSendFrame();
          }, 1000);

        } catch (err: any) {
          console.error('Video initialization error:', err);
          setError('Failed to access camera/screen: ' + (err?.message || String(err)));

          if (videoSource === 'screen') {
            // Reset chat mode and clean up any existing connections
            setChatMode(null);
            stopStream();
          }

          setVideoEnabled(false);
          setVideoSource(null);
        }
      };

      startVideo();

      // Cleanup function
      return () => {
        if (videoStreamRef.current) {
          videoStreamRef.current.getTracks().forEach(track => track.stop());
          videoStreamRef.current = null;
        }
        if (videoIntervalRef.current) {
          clearInterval(videoIntervalRef.current);
          videoIntervalRef.current = null;
        }
      };
    }
  }, [videoEnabled, videoSource]);

  // Frame capture function
  const captureAndSendFrame = () => {
    if (!canvasRef.current || !videoRef.current || !wsRef.current) return;

    const context = canvasRef.current.getContext('2d');
    if (!context) return;

    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;

    context.drawImage(videoRef.current, 0, 0);
    const base64Image = canvasRef.current.toDataURL('image/jpeg').split(',')[1];

    wsRef.current.send(JSON.stringify({
      type: 'image',
      data: base64Image
    }));
  };

  // Toggle video function
  const toggleVideo = () => {
    setVideoEnabled(!videoEnabled);
    // Update mode when toggling video off -> back to audio
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: 'mode', mode: !videoEnabled ? (videoSource ?? 'camera') : 'audio' }));
    }
  };

  const stopVideo = () => {
    setVideoEnabled(false);
    setVideoSource(null);
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: 'mode', mode: 'audio' }));
    }
    if (videoStreamRef.current) {
      videoStreamRef.current.getTracks().forEach(t => t.stop());
      videoStreamRef.current = null;
    }
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
  };

  // Start YouTube chat watcher
  const startYouTubeChat = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const id = extractYouTubeVideoId(ytVideoId);
    if (!id) {
      setError('Invalid YouTube URL or Video ID');
      return;
    }
    setYtChatLog([]);
    wsRef.current.send(JSON.stringify({ type: 'yt_chat_start', video_id: id }));
  };

  const stopYouTubeChat = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'yt_chat_stop' }));
  };

  const extractYouTubeVideoId = (input: string): string | null => {
    if (!input) return null;
    // Direct ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
    // Standard URL
    const m1 = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (m1) return m1[1];
    // Shorts or direct path
    const m2 = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (m2) return m2[1];
    const m3 = input.match(/youtube\.com\/live\/([a-zA-Z0-9_-]{11})/);
    if (m3) return m3[1];
    return null;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopVideo();
      stopStream();
    };
  }, []);

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="space-y-6">
        <h1 className="text-4xl font-bold tracking-tight">Ai_Eva✨</h1>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="system-prompt">System Prompt</Label>
              <Textarea
                id="system-prompt"
                value={config.systemPrompt}
                onChange={(e) => setConfig(prev => ({ ...prev, systemPrompt: e.target.value }))}
                disabled={isConnected}
                className="min-h-[100px]"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="voice-select">Voice</Label>
              <Select
                value={config.voice}
                onValueChange={(value) => setConfig(prev => ({ ...prev, voice: value }))}
                disabled={isConnected}
              >
                <SelectTrigger id="voice-select">
                  <SelectValue placeholder="Select a voice" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((voice) => (
                    <SelectItem key={voice} value={voice}>
                      {voice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="google-search"
                checked={config.googleSearch}
                onCheckedChange={(checked) =>
                  setConfig(prev => ({ ...prev, googleSearch: checked as boolean }))}
                disabled={isConnected}
              />
              <Label htmlFor="google-search">Enable Google Search</Label>
            </div>

            <div className="space-y-2">
              <Label htmlFor="yt-video-id">YouTube Live URL or Video ID</Label>
              <input
                id="yt-video-id"
                type="text"
                value={ytVideoId}
                onChange={(e) => setYtVideoId(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                placeholder="https://www.youtube.com/watch?v=..."
                disabled={!isConnected}
              />
              <div className="flex gap-2">
                <Button onClick={startYouTubeChat} disabled={!isConnected || ytChatEnabled} className="gap-2">Start YouTube Chat</Button>
                <Button onClick={stopYouTubeChat} disabled={!isConnected || !ytChatEnabled} variant="secondary" className="gap-2">Stop YouTube Chat</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-4">
          {!isStreaming && (
            <>
              <Button
                onClick={() => startStream('audio')}
                disabled={isStreaming}
                className="gap-2"
              >
                <Mic className="h-4 w-4" />
                Start Chatting
              </Button>

              <Button
                onClick={() => startStream('camera')}
                disabled={isStreaming}
                className="gap-2"
              >
                <Video className="h-4 w-4" />
                Start Chatting with Video
              </Button>

              <Button
                onClick={() => startStream('screen')}
                disabled={isStreaming}
                className="gap-2"
              >
                <Monitor className="h-4 w-4" />
                Start Chatting with Screen
              </Button>
            </>


          )}

          {isStreaming && (
            <Button
              onClick={stopStream}
              variant="destructive"
              className="gap-2"
            >
              <StopCircle className="h-4 w-4" />
              Stop Chat
            </Button>
          )}
        </div>

        {isStreaming && (
          <Card>
            <CardContent className="flex items-center justify-center h-24 mt-6">
              <div className="flex flex-col items-center gap-2">
                <Mic className="h-8 w-8 text-blue-500 animate-pulse" />
                <p className="text-gray-600">Listening...</p>
              </div>
            </CardContent>
          </Card>
        )}

        {(chatMode === 'video') && (
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold">Video Input</h2>
              </div>

              <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  width={320}
                  height={240}
                  className="w-full h-full object-contain"
                  //style={{ transform: 'scaleX(-1)' }}
                  style={{ transform: videoSource === 'camera' ? 'scaleX(-1)' : 'none' }}
                />
                <canvas
                  ref={canvasRef}
                  className="hidden"
                  width={640}
                  height={480}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {text && (
          <Card>
            <CardContent className="pt-6">
              <h2 className="text-lg font-semibold mb-2">Conversation:</h2>
              <pre className="whitespace-pre-wrap text-gray-700">{text}</pre>
            </CardContent>
          </Card>
        )}

        {ytChatLog.length > 0 && (
          <Card>
            <div className="pt-6">
              <h2 className="text-lg font-semibold mb-4">YouTube Live Chat (ล่าสุด 3 ข้อความ):</h2>
              {(() => {
                const lastThree = ytChatLog.slice(-3); // แสดงเฉพาะ 3 ข้อความล่าสุด
                return (
                  <ul className="space-y-2">
                    {lastThree.map((msg, idx) => {
                      const isLatest = idx === lastThree.length - 1;
                      return (
                        <li
                          key={idx}
                          className={`text-sm rounded-md px-3 py-2 border flex items-start gap-2 shadow-sm transition-colors ${
                            isLatest
                              ? 'bg-blue-50 border-blue-300 text-blue-800 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-200'
                              : 'bg-gray-50 border-gray-200 text-gray-700 dark:bg-gray-800/40 dark:border-gray-700 dark:text-gray-200'
                          }`}
                        >
                          <span className="inline-block w-2 h-2 mt-1 rounded-full bg-current opacity-60" />
                          <span className="flex-1 break-words leading-relaxed">{msg}</span>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
              <p className="mt-3 text-[11px] text-gray-400 italic">(ระบบเก็บทั้งหมด แต่แสดงเฉพาะ 3 ข้อความล่าสุด)</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}