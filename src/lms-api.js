const axios = require('axios').default;
/**
 * Our LMS object that handles interaction with the LMS.  This script currently supports
 * Moodle's API.
 *
 * @type {Object}
 */
const lms = {};
lms.url = '';
lms.token = '';
/**
 * Do we have everything to make a request?
 *
 * @return {boolean}  yes|no
 */
lms.can_make_request = () =>  {
  return ((lms.token !== '') && (lms.url !== ''));
};
/**
 * Get all the users of the LMS.
 *
 * @return {Promise} The JSON response
 */
lms.get_users = async ()  =>  {
  if (!lms.can_make_request()) {
    return 'You need to set the url and token!';
  }

  const params = {
    'wstoken': lms.token,
    'wsfunction': 'core_user_get_users',
    'moodlewsrestformat': 'json',
    'criteria[0][key]': 'lastname',
    'criteria[0][value]': '%',
  };
  const response = await axios.post(lms.url, null, {params: params});
  return response.data;
};
/**
 * Get the user based on the given id
 * @param  {integer}  id  The user id
 * @return {Promise}  The JSON response
 */
lms.get_user = async (id) =>  {
  if (!lms.can_make_request()) {
    return 'You need to set the url and token!';
  }
  if (!id) {
    return 'You must supply a vaild id!';
  }

  const params = {
    'wstoken': lms.token,
    'wsfunction': 'core_user_get_users_by_field',
    'moodlewsrestformat': 'json',
    'field': 'id',
    'values': [id],
  };
  const response = await axios.post(lms.url, null, {params: params});
  return response.data;
}
/**
 * Create a new user in the LMS
 *
 * @param  {object}  data The JSON object of data for the new user
 * @return {Promise}      The JSON response
 */
lms.post_user = async (data)  =>  {
  if (!lms.can_make_request()) {
    return 'You need to set the url and token!';
  }
  if ((!('username' in data)) || (data.username === '')) {
    return 'You must supply a valid username!';
  }
  if ((!('firstname' in data)) || (data.firstname === '')) {
    return 'You must supply a valid firstname!';
  }
  if ((!('lastname' in data)) || (data.lastname === '')) {
    return 'You must supply a valid lastname!';
  }
  if ((!('email' in data)) || (data.email === '')) {
    return 'You must supply a valid email!';
  }
  if (
    ((!('password' in data)) || (data.password === '')) &&
    ((!('createpassword' in data)) || (data.createpassword !== 1))
  ) {
    return 'You must supply a valid password or createpassword!';
  }

  // Check provided data
  const params = {
    'wstoken': lms.token,
    'wsfunction': 'core_user_create_users',
    'moodlewsrestformat': 'json',
    'users[0][username]': data.username,
    'users[0][firstname]': data.firstname,
    'users[0][lastname]': data.lastname,
    'users[0][email]': data.email,
  };
  if ('password' in data) {
    params['users[0][password]'] = data.password;
  } else if ('createpassword' in data) {
    params['users[0][createpassword]'] = 1;
  } else {
    return 'You must supply a valid password or createpassword!';
  }
  const optionals = [
    'maildisplay', 'city', 'country', 'timezone', 'description', 'middlename',
    'alternatename', 'url', 'icq', 'skype', 'aim', 'yahoo', 'msn', 'institution', 'department',
    'phone1', 'phone2', 'address', 'lang', 'mailformat'
  ];
  optionals.filter((field) => (field in data)).forEach((field) => params['users[0]['+field+']'] = data[field]);
  const response = await axios.post(lms.url, null, {params: params});
  return response.data;
};

module.exports = lms;
