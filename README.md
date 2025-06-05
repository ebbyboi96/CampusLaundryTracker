# Campus Laundry Tracker
This is a pet project of mine, I've been fed up with wash's campuscleanpay app, so I cooked up a little web version. A live demo is available at [campuslaundry.live](https://www.campuslaundry.live). 

## Usage
### Accessing the site
simply visit your frontend of choice whether that be my [live demo](https://www.campuslaundry.live), or your self hosted version, likely found at [http://localhost:3000](http://localhost:3000). There is no login page.
### Finding your room
Type in the location code provided in your laundry room. It likely follows the general format of `W######` (where '#' represents a number). Then click `Set Location & View Rooms`.
From here, it should list all laundry rooms found at your location. Choose the one you use and from there the machines statuses should be visible.

## Self hosting
The folks over there might not enjoy me hosting this, so self hosting is probably the way to go for a long term solution. **USE AT YOUR OWN RISK!**. Self hosting requires signing up for an account and agreeing to their TOS which forbids using an account for purposes such as these.
### Configuration
Simply update `config-example.json` with your desired port, and login credentials. Then rename the file to `config.json`. That's it!
### Running it.
Getting it running should be as simple as running `npm install` followed by `node server.js`.
