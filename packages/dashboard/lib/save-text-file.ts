import { Platform, Share } from 'react-native';

/**
 * Hand a generated text file (a CSV export) to the person.
 *
 * On the web it is saved as a download; on a device it goes to the share sheet,
 * which is where a native app offers "save to Files" and "send to…".
 */
export async function saveTextFile(filename: string, text: string, mime: string): Promise<void> {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return;
  }
  await Share.share({ title: filename, message: text });
}
