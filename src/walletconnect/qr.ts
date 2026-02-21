import QRCode from 'qrcode';

/**
 * Generate a QR code as a data URL (base64 PNG)
 */
export async function generateQRDataUrl(data: string): Promise<string> {
  return QRCode.toDataURL(data, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });
}

/**
 * Generate a QR code as a Buffer (PNG)
 */
export async function generateQRBuffer(data: string): Promise<Buffer> {
  return QRCode.toBuffer(data, {
    errorCorrectionLevel: 'M',
    type: 'png',
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });
}

/**
 * Generate a QR code as a string (terminal/ASCII)
 */
export async function generateQRString(data: string): Promise<string> {
  return QRCode.toString(data, {
    type: 'terminal',
    small: true,
  });
}
