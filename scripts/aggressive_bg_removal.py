from PIL import Image, ImageChops

def aggressive_remove_bg(input_path, output_path):
    img = Image.open(input_path).convert("RGBA")
    pix = img.load()
    width, height = img.size

    # Target specific dark/muddy background colors
    # We want to keep the bright neon parts but remove the surrounding dark square
    for y in range(height):
        for x in range(width):
            r, g, b, a = pix[x, y]
            
            # Brightness calculation
            brightness = (r + g + b) / 3
            
            # If it's very dark or has low saturation (grayish), make it transparent
            # Also checking for the specific "muddy teal" box seen in the screenshot
            # The box seems to be around RGB(10-30, 20-40, 20-40)
            if brightness < 45 or (r < 40 and g < 50 and b < 50 and (abs(r-g) < 15 and abs(g-b) < 15)):
                pix[x, y] = (0, 0, 0, 0)

    # Secondary pass: Remove almost-transparent pixels that cause "ghosting"
    for y in range(height):
        for x in range(width):
            r, g, b, a = pix[x, y]
            if a < 30: # If it's mostly transparent, make it fully transparent
                pix[x, y] = (0, 0, 0, 0)

    img.save(output_path, "PNG")
    print(f"Aggressively processed {input_path} -> {output_path}")

# Run for dark logo
aggressive_remove_bg(
    "/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_dark_neon_fixed.png",
    "/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos/at_logo_glass_dark_neon_fixed.png"
)
