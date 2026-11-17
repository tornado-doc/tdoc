import React from 'react';
import { AppButton } from '../ui/button.jsx';
import { AppDialog } from '../ui/dialog.jsx';

export function SocialVideoDialog({ video, onClose }) {
  if (!video) return null;
  return (
    <AppDialog
      open
      title={video.title || `${video.platform} video`}
      className={`tdoc-video-dialog${video.vertical ? ' tdoc-video-vertical' : ''}`}
      onOpenChange={(open) => { if (!open) onClose(); }}
      actions={<>
        <a href={video.source} target="_blank" rel="noopener noreferrer">Open in a new tab ↗</a>
        <AppButton onClick={onClose}>Close</AppButton>
      </>}
    >
      <iframe
        className="tdoc-video-player"
        src={video.embed}
        title={`${video.platform} video player`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="origin"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
      />
    </AppDialog>
  );
}
