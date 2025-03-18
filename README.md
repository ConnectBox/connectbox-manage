# connectbox-manage
This project replaces the 2018 Bash script ConnectBoxManage.sh in connectbox-pi and the chat API to simplify the chat delievery through eliminating SQL and using node's ability to retain state during operation.

This is a node.js javascript application leveraging a common library of management functions for the Connectbox based platforms.  These functions are available through an API and through a command-line interface (CLI).

* The application is written in nodejs and runs in the pm2 process handler for nodejs applications.  The API is available on port 5002.
* The CLI is written in python and converts command line arguments into API calls hitting the localhost:5002 API.  This was done due to performance issues with the nodejs CLI on low capability CPUs.

# Installation and Development
Connectbox-pi Ansible will install this application but should you want to install on another machine or for development:
* git clone the repo to your machine.
* Install nodejs 14+ and npm for your type of machine
* Navigate to the repo's home directory and run `npm install` to install the node packages in packages.json
* In the src directory, run `node index.js` to start the API web application -- runs on port 5002
* In the src direction, run `node cli` for usage and examples

# Chat
The application allows PUT to chat and GET from chat:
* PUT `/chat`: Example Call: `{"body": "Hi", "nick": "VogelKohen42", "textDirection": "ltr"}` will return a 200 or 500 if invalid
* GET `/chat/:lastMessage` replace `:lastMessage` with timestamp (UNIX epoch time without milliseconds) of last retrieved message to get just the latest messages.  Example Call: `/chat/1645451503`
* API cleans up messages more than 3 hours old.  If application is restarted (see pm2 details below), chat cache is cleared.

# Developing Additional Functions
The API and the CLI will execute new commands found in the functions.js file.  Each function should be formatted according to existing functions and have the following characteristics:
* Have a header line for self-documenting usage:
  `//DICT:SET:clientssid (string): Client Wi-Fi SSID`
  - DICT indicates the line is self-documenting description
  - GET/SET/DO indicates the type of function
  - clientssid is the name of the function
  - (string) indicates the type of input expected
  - Lastly a text description

* A new function should start with `get.` `set.` or `doCommand.` as shown in functions.js
```
//DICT:GET:clientssid: Client Wi-Fi SSID
get.clientssid = function (){
	return (execute(`grep 'ssid' /etc/wpa_supplicant/wpa_supplicant.conf | cut -d'"' -f2`))
}
```

# Deployment Options
* By default the [connectbox-pi repo](https://github.com/ConnectBox/connectbox-pi/blob/master/ansible/roles/enhanced-content/tasks/main.yml) installs these tools in /var/www/enhanced/connectbox-manage and uses [pm2](https://pm2.keymetrics.io/) to serve as process manager.  Helpful commands are: `pm2 status` `pm2 restart all` `pm2 logs`
* Execute as a nodejs application as shown in the [Installation and Deployment](#installation-and-development) section above.
* A nodejs docker could be used to run the application.
