from PIL import Image
import os

def remove_background(input_path, output_path, mod_type='dark'):
    img = Image.open(input_path).convert("RGBA")
    datas = img.getdata()

    newData = []
    if mod_type == 'dark':
        # For the dark logo, we want to remove the dark gray square.
        # The background in the screenshot is roughly (43, 43, 43) or similar.
        # We can also use a threshold to make everything dark transparent.
        for item in datas:
            # If the pixel is very dark (background is roughly 30-50 range), make it transparent
            # But we must be careful not to remove the logo details.
            # A better way for 'screen' like effect is to set alpha based on brightness
            brightness = sum(item[:3]) / 3
            if brightness < 60: # Threshold for the dark gray background
                newData.append((item[0], item[1], item[2], 0))
            else:
                newData.append(item)
    else:
        # For the light logo, remove white/near-white
        for item in datas:
            if item[0] > 240 and item[1] > 240 and item[2] > 240:
                newData.append((255, 255, 255, 0))
            else:
                newData.append(item)

    img.putdata(newData)
    img.save(output_path, "PNG")
    print(f"Processed {input_path} -> {output_path}")

logo_dir = "/Users/filipkrejca/Downloads/alphatrade-mentor-15/public/logos"
remove_background(os.path.join(logo_dir, "at_logo_glass_light.png"), os.path.join(logo_dir, "at_logo_glass_light_fixed.png"), 'light')
remove_background(os.path.join(logo_dir, "at_logo_glass_dark_neon.png"), os.path.join(logo_dir, "at_logo_glass_dark_neon_fixed.png"), 'dark')
