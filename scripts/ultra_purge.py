from PIL import Image

def ultra_purge_logo(path):
    img = Image.open(path).convert("RGBA")
    pix = img.load()
    width, height = img.size
    
    print(f"Purging {path}...")
    
    # We will only keep pixels that have a significant color value
    # and are not too dark.
    for y in range(height):
        for x in range(width):
            r, g, b, a = pix[x, y]
            
            # Brightness check
            brightness = (r + g + b) / 3
            
            # In the neon logo, the core is white/cyan, the glow is teal.
            # Anything that's grayish/brownish or very dark must go.
            
            # Kill anything with very low alpha immediately
            if a < 50:
                pix[x, y] = (0, 0, 0, 0)
                continue

            # Kill anything that is too dark (background artifact)
            if brightness < 85:
                pix[x, y] = (0, 0, 0, 0)
                continue
                
            # Kill anything that doesn't have the "cyan/teal" signature 
            # (Neon cyan should have G and B significantly higher than R, or R should be high too for white core)
            # If it's too "red" or "yellow" or "purple", it's probably noise
            # For the dark neon logo, it's mostly G and B.
            if r > g and r > 100: # Too red (unless it's white)
                if abs(r-g) > 30 and abs(r-b) > 30:
                    pix[x, y] = (0, 0, 0, 0)

    # Let's also do a coordinate-based purge. 
    # If a pixel is far from the center of mass, and isn't bright, kill it.
    img.save(path)
    
    # Reload and crop
    img = Image.open(path).convert("RGBA")
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
        # Add a small 2px padding of pure transparency to ensure filters don't "catch" the edge
        new_img = Image.new("RGBA", (img.width + 4, img.height + 4), (0, 0, 0, 0))
        new_img.paste(img, (2, 2))
        new_img.save(path)
        print(f"Final size for {path}: {new_img.size}")

ultra_purge_logo("/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_dark_neon_fixed.png")
ultra_purge_logo("/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_light_fixed.png")
