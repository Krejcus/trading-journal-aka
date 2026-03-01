export async function cropImage(dataUrl: string, rect: DOMRect): Promise<string> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const dpr = window.devicePixelRatio || 1;

            // Adjust coordinates for high-DPI displays (Retina)
            const x = rect.left * dpr;
            const y = rect.top * dpr;
            const width = rect.width * dpr;
            const height = rect.height * dpr;

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            if (ctx) {
                // Draw only the specified rect from the source image
                ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
                resolve(canvas.toDataURL('image/png', 0.9)); // slight compression
            } else {
                resolve(dataUrl); // fallback if canvas fails
            }
        };
        img.src = dataUrl;
    });
}
