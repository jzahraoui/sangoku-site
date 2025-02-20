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
  Tools to adjust measurements gain, align subwoofer, and generate optimized configurations for room correction.
  
- **Configuration Export:**  
  Generate OCA file that can be used to program your audio processing hardware.

## Project Structure

- **index.html:**  
  The main entry point containing the HTML structure, interactive controls, and status messages. It also includes links for donation, social credits, and navigation to help resources.

- **default.css:**  
  The stylesheet defining the visual layout and responsive design for the application.

- **JavaScript Files:**
  - **main.js:**  
    Main application logic and view-model instantiation, integrating with REW commands and file parsing.
  - **MeasurementItem.js:**  
    Contains code for processing measurement data including filtering, and transformation.
  - **MeasurementViewModel.js:**  
    Implements the view model for handling measurement data, user interactions, and API service communication.
  - **multi-sub-optimizer.js:**  
    Implements algorithms to process subwoofer measurements and optimize their alignment and tuning.

## Usage

### Basic Setup

1. Download and install the latest REW beta
2. Import your .avr file generated from the odd executable or .ady from mobile app
3. Connect to REW using the "Connect" button
4. Use provided tools to creates your personalised configuration

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

## Disclaimer

This tool is provided for experimental and informational purposes only. **Before sending any configuration to your equipment, please verify all parameters carefully.** The generated configurations and adjustments are based on user-provided data and may not be appropriate for every scenario. Incorrect settings may lead to undesirable behavior or may potentially damage your audio hardware. By using this tool, you agree that you assume all responsibility and risk associated with its use. The developers are not liable for any damage or malfunction that may occur as a result of applying the generated configurations.

## Contributing

Contributions are welcome! Please feel free to submit pull requests.

- Fork the repository and submit a pull request with your improvements.
- Ensure your changes follow the coding style used in the project.
- Update documentation and tests as needed.

## Credits

Designed & Developed by Sangoku

## Support

If you find this tool helpful, consider supporting the development:

- PayPal donations
- Patreon support

## License

This project is licensed under the GNUA License. See the LICENSE file for details.
Copyright © 2025 Sangoku

## Version

Current Version: 1.0
