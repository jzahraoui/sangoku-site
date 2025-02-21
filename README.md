# Room Correction Helper

Room Correction Helper is a web-based tool designed to work alongside REW (Room EQ Wizard) for measuring, aligning, and optimizing room correction settings. It streamlines the process of importing acoustic measurements (AVR/ADY files), aligning timming and SPL (sound pressure level), and generating configurations such as EQ filters and multi‑subwoofer setups into an OCA file.

## Overview

Room Correction Helper is a specialized tool designed to assist in:

- Processing and analyzing audio measurements
- Optimizing multi-subwoofer configurations
- Managing room correction data
- Integrating with Room EQ Wizard (REW)

## Features

- **Multi-Language Support**
  - English
  - French

- **REW Integration**
  - Direct connection to REW API
  - Automated measurement renaming

- **Measurement Import:**  
  - Drag-and-drop support for AVR/ADY files exported from mobile app or similar odd.wtf software.
  - Automatic channel detection
  - Configuration visualization
  - Automatic measurement import into REW
  
- **SPL and Multi-Subwoofer Optimization:**  
  Tools to adjust measurements gain, align subwoofer, and generate optimized configurations. Includes automatic alignment tools to ensure proper synchronization between different speakers. Uses impulse response analysis to determine peak alignment points.

- **Preview**  
  Apply AVR filters processing on the current work to generates accurates preview of the signal.
  
- **Configuration Export:**  
  Generate OCA file that can be used to program your audio processing hardware.

## Project Structure

- **index.html:**  
  The main entry point containing the HTML structure, interactive controls, and status messages. It also includes links for donation, social credits, and navigation to help resources.

- **default.css:**  
  The stylesheet defining the visual layout and responsive design for the application.

- **JavaScript Files:**
  - **MeasurementItem.js:**  
    Contains code for processing measurement data including filtering, and transformation.
  - **MeasurementViewModel.js:**  
    Implements the view model for handling measurement data, user interactions, and API service communication.
  - **multi-sub-optimizer.js:**  
    Implements algorithms to process subwoofer measurements and optimize their alignment and tuning.

## Usage

### Basic Setup

1. Download and install the latest REW beta (minimum v71)
2. Import your .ady created from mobile app
3. Or import your .avr file generated from the odd executable and your manually made measurements in REW
4. Connect to REW using the "Connect" button

### Multi-Sub Optimization

1. available if multiple subs measurements founds into REW
2. Use the "Optimize Sub" feature
3. Suggested configuration is applyed to your subs
4. Generate preview LFE predicted by using "sum sub" button

### Speaker Tools

1. Select measurements to process
2. Choose averaging method
3. Apply SPL or peak alignment as needed
4. Generate filters
5. use find sub alignement to apply timming to your sub

### Filter Design & Application

Users can design custom filters or apply predefined equalization settings.
Automatic filters implements recursive filtering for smooth transitions between frequency bands. they are limited to 500Hz.
Filters are applied to measurements using convolution processing.

### generates OCA file

check the filters.
generates preview.
creates oca file.
import it to your receiver using the odd program.

## Disclaimer

This tool is provided for experimental and informational purposes only. **Before sending any configuration to your equipment, please verify all parameters carefully.** The generated configurations and adjustments are based on user-provided data and may not be appropriate for every scenario. Incorrect settings may lead to undesirable behavior or may potentially damage your audio hardware. By using this tool, you agree that you assume all responsibility and risk associated with its use. The developers are not liable for any damage or malfunction that may occur as a result of applying the generated configurations.

## Contributing

Contributions are welcome! Feel free to:

- Report issues
- Suggest new features
- Submit pull requests
- Improve documentation

## Thanks & Acknowledgments

Special thanks to:

- John Mulcahy for his excellent audio measurement software [Room EQ Wizard (REW)](https://www.roomeqwizard.com/)
- @ratneuron, the author of odd program
- All users who have supported this project through PayPal and Patreon donations
- The open-source community for providing the libraries used in this project:
  - Knockout.js
  - js-yaml
  - JSZip
  - FileSaver.js
  - math.js
  - Font Awesome

Your support helps maintain and improve this room correction helper tool. Whether through code contributions, bug reports, or donations, every form of support is greatly appreciated.

## Credits

Designed & Developed by Sangoku

## Support

If you find this tool helpful, consider supporting the development:

- [PayPal](https://www.paypal.com/donate/?hosted_button_id=V53J7XLBD3A2C)
- [Patreon](https://www.patreon.com/Sangoku)

## License

This project is licensed under the GNUA License. See the LICENSE file for details.
Copyright © 2025 Sangoku

## Version

Current Version: 1.0
