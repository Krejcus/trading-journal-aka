from PIL import Image

def fix_logo_final(path):
    img = Image.open(path).convert("RGBA")
    pix = img.load()
    width, height = img.size
    
    # Sample the corners to find the "background" color
    corners = [pix[0,0], pix[width-1, 0], pix[0, height-1], pix[width-1, height-1]]
    print(f"Sampling corners for {path}: {corners}")

    # Aggressive removal: 
    # Any pixel that is dark (brightness < 80) AND not "vibrant cyan" gets killed.
    # Vibrant cyan has high G and B compared to R.
    for y in range(height):
        for x in range(width):
            r, g, b, a = pix[x, y]
            
            # Simple brightness
            brightness = (r + g + b) / 3
            
            # Distance from a "pure" cyan neon color (roughly 45, 212, 191)
            # If it's too far from the neon light range and too dark, it's background
            is_neon = (g > 150 and b > 150) # Very loose definition of neon cyan
            
            if not is_neon and brightness < 100:
                pix[x, y] = (0, 0, 0, 0)
            
            # Special case for the "muddy" teal box corners
            # If it's nearly grayscale and dark
            if abs(r-g) < 20 and abs(g-b) < 20 and brightness < 60:
                pix[x, y] = (0, 0, 0, 0)

    # Third pass: Anything within a 10px border that isn't bright is gone
    margin = 5
    for y in range(height):
        for x in range(width):
            if x < margin or y < margin or x > (width - margin) or y > (height - margin):
                r, g, b, a = pix[x, y]
                if (r + g + b) / 3 < 150: # If not very bright neon edge, kill it
                    pix[x, y] = (0, 0, 0, 0)

    # Save
    img.save(path, "PNG")
    
    # Now try to crop again
    img = Image.open(path).convert("RGBA")
    bbox = img.getbbox()
    if bbox:
        img.crop(bbox).save(path)
        print(f"Fixed and cropped to {img.crop(bbox).size}")

fix_logo_final("/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_dark_neon_fixed.png")
fix_logo_final("/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_light_fixed.png")
