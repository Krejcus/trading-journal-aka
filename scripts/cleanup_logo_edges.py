from PIL import Image
import os

def clean_stray_pixels(input_path, output_path):
    img = Image.open(input_path).convert("RGBA")
    width, height = img.size
    pix = img.load()

    # Specifically target the top-left area where the "white dot" was reported
    # We'll clear a small margin around the edges just to be safe from any generation artifacts
    margin = 15 
    
    for y in range(height):
        for x in range(width):
            # If we are in the outer margin, make it transparent
            if x < margin or y < margin or x > (width - margin) or y > (height - margin):
                r, g, b, a = pix[x, y]
                pix[x, y] = (r, g, b, 0)
            
    img.save(output_path, "PNG")
    print(f"Cleaned stray pixels from {input_path} -> {output_path}")

logo_dir = "/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos"
# Clean the already "fixed" versions to ensure we don't introduce new artifacts
clean_stray_pixels(os.path.join(logo_dir, "at_logo_glass_dark_neon_fixed.png"), os.path.join(logo_dir, "at_logo_glass_dark_neon_fixed.png"))
clean_stray_pixels(os.path.join(logo_dir, "at_logo_glass_light_fixed.png"), os.path.join(logo_dir, "at_logo_glass_light_fixed.png"))
